"""Live traffic-restriction parsing and routing overlays.

Remote ingestion is deliberately disabled unless configured. A stale or failed
feed always produces a fail-open snapshot so routing remains available.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, datetime
from threading import Lock
from typing import Any, Callable

import networkx as nx
from shapely.geometry import LineString
from shapely.strtree import STRtree


logger = logging.getLogger("detour.restrictions")
EdgeId = tuple[Any, Any, Any]
EdgeWeight = str | Callable[[Any, Any, Any, dict[str, Any]], float | None]


@dataclass(frozen=True)
class TrafficRestriction:
    id: str
    start_at: datetime | None
    end_at: datetime | None
    kind: str
    subtype: str
    description: str
    direction: str
    coordinates: tuple[tuple[float, float], ...]  # longitude, latitude
    severity: str


@dataclass(frozen=True)
class EdgeRestriction:
    restriction_id: str
    severity: str
    penalty: float | None


@dataclass(frozen=True)
class RestrictionSnapshot:
    version: str
    status: str
    fetched_at: datetime
    feed_timestamp: datetime | None = None
    restrictions: tuple[TrafficRestriction, ...] = ()
    affected_edges: dict[EdgeId, tuple[EdgeRestriction, ...]] = field(default_factory=dict)
    detail: str | None = None

    def payload(self, route_edges: set[EdgeId] | None = None) -> dict[str, Any]:
        route_edges = route_edges or set()
        used = {
            item.restriction_id
            for edge_id in route_edges
            for item in self.affected_edges.get(edge_id, ())
        }
        return {
            "status": self.status,
            "version": self.version,
            "fetched_at": isoformat(self.fetched_at),
            "feed_timestamp": isoformat(self.feed_timestamp),
            "active_restriction_count": len(self.restrictions),
            "matched_edge_count": len(self.affected_edges),
            "route_restriction_ids": sorted(used),
            "detail": self.detail,
        }


def isoformat(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


def parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
    except ValueError:
        return None


def decode_polyline(value: str) -> tuple[tuple[float, float], ...]:
    """Decode a Google encoded polyline into (longitude, latitude) pairs."""
    coordinates: list[tuple[float, float]] = []
    index = latitude = longitude = 0
    while index < len(value):
        deltas: list[int] = []
        for _ in range(2):
            result = shift = 0
            while index < len(value):
                byte = ord(value[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        latitude += deltas[0]
        longitude += deltas[1]
        coordinates.append((longitude / 1e5, latitude / 1e5))
    return tuple(coordinates)


def parse_coordinates(value: Any) -> tuple[tuple[float, float], ...]:
    if isinstance(value, dict):
        value = value.get("coordinates")
    if isinstance(value, list):
        points = value[0] if value and isinstance(value[0], list) and value[0] and isinstance(value[0][0], list) else value
        try:
            return tuple((float(point[0]), float(point[1])) for point in points)
        except (TypeError, ValueError, IndexError):
            return ()
    if not isinstance(value, str) or not value.strip():
        return ()
    raw = value.strip()
    try:
        decoded = json.loads(raw)
        return parse_coordinates(decoded)
    except json.JSONDecodeError:
        pass
    return decode_polyline(raw)


def severity_for(kind: str, subtype: str, description: str) -> str:
    text = " ".join((kind, subtype, description)).lower()
    if any(token in text for token in ("closed", "closure", "fermé", "fermeture", "blocked", "barré", "complete")):
        return "closed"
    if any(token in text for token in ("cycle", "bike", "vélo", "piste cyclable", "lane", "voie")):
        return "major"
    return "caution"


def parse_cifs(payload: dict[str, Any], now: datetime | None = None) -> tuple[tuple[TrafficRestriction, ...], datetime | None]:
    now = now or datetime.now(UTC)
    raw_events = payload.get("events") or payload.get("traffic_events") or payload.get("data") or []
    if isinstance(raw_events, dict):
        raw_events = raw_events.get("events") or raw_events.get("items") or []
    restrictions: list[TrafficRestriction] = []
    for raw in raw_events:
        location = raw.get("location") or {}
        coordinates = parse_coordinates(location.get("polyline") or raw.get("polyline") or raw.get("geometry"))
        if len(coordinates) < 2:
            continue
        start_at = parse_datetime(raw.get("starttime") or raw.get("start_time"))
        end_at = parse_datetime(raw.get("endtime") or raw.get("end_time"))
        if start_at and start_at > now or end_at and end_at < now:
            continue
        kind = str(raw.get("type") or "unknown")
        subtype = str(raw.get("subtype") or "")
        description = str(raw.get("description") or "")
        restrictions.append(
            TrafficRestriction(
                id=str(raw.get("id") or hashlib.sha1(repr(raw).encode()).hexdigest()[:16]),
                start_at=start_at,
                end_at=end_at,
                kind=kind,
                subtype=subtype,
                description=description,
                direction=str(location.get("direction") or "BOTH_DIRECTIONS"),
                coordinates=coordinates,
                severity=severity_for(kind, subtype, description),
            )
        )
    return tuple(restrictions), parse_datetime(payload.get("timestamp"))


def edge_lines(graph: nx.MultiDiGraph) -> tuple[list[EdgeId], list[LineString]]:
    ids: list[EdgeId] = []
    lines: list[LineString] = []
    for u, v, key, data in graph.edges(keys=True, data=True):
        geometry = data.get("geometry")
        line = geometry if geometry is not None else LineString(
            [(float(graph.nodes[u]["x"]), float(graph.nodes[u]["y"])), (float(graph.nodes[v]["x"]), float(graph.nodes[v]["y"]))]
        )
        ids.append((u, v, key))
        lines.append(line)
    return ids, lines


def match_restrictions(graph: nx.MultiDiGraph, restrictions: tuple[TrafficRestriction, ...], tolerance_m: float = 18) -> dict[EdgeId, tuple[EdgeRestriction, ...]]:
    if not restrictions:
        return {}
    edge_ids, lines = edge_lines(graph)
    tree = STRtree(lines)
    latitude = sum(float(data["y"]) for _, data in graph.nodes(data=True)) / max(graph.number_of_nodes(), 1)
    latitude_tolerance = tolerance_m / 111_000
    longitude_tolerance = tolerance_m / (111_000 * max(math.cos(math.radians(latitude)), 0.1))
    tolerance = max(latitude_tolerance, longitude_tolerance)
    matches: dict[EdgeId, list[EdgeRestriction]] = {}
    penalties = {"closed": None, "major": 8.0, "caution": 2.0}
    for restriction in restrictions:
        area = LineString(restriction.coordinates).buffer(tolerance)
        for index in tree.query(area, predicate="intersects"):
            edge_id = edge_ids[int(index)]
            matches.setdefault(edge_id, []).append(
                EdgeRestriction(restriction.id, restriction.severity, penalties[restriction.severity])
            )
    return {edge_id: tuple(items) for edge_id, items in matches.items()}


def restriction_weight(base_weight: str, snapshot: RestrictionSnapshot) -> EdgeWeight:
    def weight(u: Any, v: Any, key: Any, data: dict[str, Any]) -> float | None:
        cost = float(data.get(base_weight, data.get("length", 1.0)))
        for restriction in snapshot.affected_edges.get((u, v, key), ()):
            if restriction.penalty is None:
                return None
            cost *= restriction.penalty
        return cost
    return weight


class TrafficRestrictionProvider:
    def __init__(self, enabled: bool, url: str, ttl_seconds: int = 90, stale_seconds: int = 300, timeout_seconds: int = 5) -> None:
        self.enabled = enabled
        self.url = url
        self.ttl_seconds = ttl_seconds
        self.stale_seconds = stale_seconds
        self.timeout_seconds = timeout_seconds
        self._lock = Lock()
        self._snapshot: RestrictionSnapshot | None = None
        self._expires_at = 0.0

    def snapshot(self, graph: nx.MultiDiGraph | None) -> RestrictionSnapshot:
        if not self.enabled:
            return RestrictionSnapshot("disabled", "disabled", datetime.now(UTC), detail="Live traffic restrictions are not enabled.")
        if graph is None:
            raise ValueError("A routing graph is required when live traffic restrictions are enabled.")
        with self._lock:
            if self._snapshot and self._expires_at > time.monotonic():
                return self._snapshot
            try:
                request = urllib.request.Request(self.url, headers={"Accept": "application/json", "User-Agent": "Detour/0.4"})
                with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                    payload = json.load(response)
                fetched_at = datetime.now(UTC)
                restrictions, feed_timestamp = parse_cifs(payload, fetched_at)
                is_stale = feed_timestamp is not None and (fetched_at - feed_timestamp).total_seconds() > self.stale_seconds
                if is_stale:
                    snapshot = RestrictionSnapshot(
                        version=f"stale:{isoformat(feed_timestamp)}", status="stale", fetched_at=fetched_at,
                        feed_timestamp=feed_timestamp, restrictions=restrictions,
                        detail="The feed timestamp is stale; restrictions were not applied.",
                    )
                else:
                    version_source = f"{isoformat(feed_timestamp)}:{','.join(item.id for item in restrictions)}"
                    snapshot = RestrictionSnapshot(
                        version=hashlib.sha1(version_source.encode()).hexdigest()[:16], status="active", fetched_at=fetched_at,
                        feed_timestamp=feed_timestamp, restrictions=restrictions,
                        affected_edges=match_restrictions(graph, restrictions),
                    )
            except Exception as error:  # fail-open boundary for an optional upstream
                logger.warning("traffic_restriction_fetch_failed", exc_info=True)
                snapshot = RestrictionSnapshot(
                    version=f"unavailable:{int(time.time() // self.ttl_seconds)}", status="unavailable",
                    fetched_at=datetime.now(UTC), detail=f"Live restriction feed unavailable: {type(error).__name__}",
                )
            self._snapshot = snapshot
            self._expires_at = time.monotonic() + self.ttl_seconds
            return snapshot
