"""Valhalla-backed bicycle routing for BIXI station pairs."""

from __future__ import annotations

import json
import math
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError

import networkx as nx

from detour_router import (
    CYCLING_SPEED_M_PER_MIN,
    WALKING_SPEED_M_PER_MIN,
    load_bixi_stations,
    nearest_station_snapshot,
    route_maneuvers,
    route_points,
    walking_station_candidates,
)


DEFAULT_BICYCLE_COSTING = {
    "bicycle_type": "city",
    "use_roads": 0.35,
    "use_hills": 0.35,
    "avoid_bad_surfaces": 0.8,
    "gate_penalty": 600,
    "destination_only_penalty": 600,
    "service_penalty": 120,
}


@dataclass(frozen=True)
class MatrixCost:
    source_index: int
    target_index: int
    duration_seconds: float
    distance_m: float


@dataclass(frozen=True)
class ValhallaRoute:
    distance_m: int
    duration_seconds: float
    coordinates: list[list[float]]
    steps: list[dict[str, Any]]
    sample_streets: list[str]


class ValhallaClient:
    def __init__(self, base_url: str, timeout_seconds: int = 10) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def _post(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{self.base_url}/{action}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "Detour/0.5"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                result = json.load(response)
        except HTTPError as error:
            try:
                detail = json.loads(error.read().decode("utf-8")).get("error")
            except (json.JSONDecodeError, UnicodeDecodeError):
                detail = None
            raise RuntimeError(f"Valhalla {action} failed ({error.code}): {detail or error.reason}") from error
        if not isinstance(result, dict):
            raise RuntimeError(f"Valhalla {action} returned an invalid response.")
        return result

    def status(self) -> None:
        request = urllib.request.Request(
            f"{self.base_url}/status",
            headers={"Accept": "application/json", "User-Agent": "Detour/0.5"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                if response.status != 200:
                    raise RuntimeError(f"Valhalla status returned HTTP {response.status}.")
        except HTTPError as error:
            raise RuntimeError(f"Valhalla status failed ({error.code}).") from error

    @staticmethod
    def _location(point: tuple[float, float]) -> dict[str, Any]:
        return {"lat": point[0], "lon": point[1], "radius": 80}

    @staticmethod
    def _costing() -> dict[str, Any]:
        return {"bicycle": dict(DEFAULT_BICYCLE_COSTING)}

    def matrix(self, sources: list[tuple[float, float]], targets: list[tuple[float, float]]) -> list[MatrixCost]:
        payload = self._post(
            "sources_to_targets",
            {
                "sources": [self._location(point) for point in sources],
                "targets": [self._location(point) for point in targets],
                "costing": "bicycle",
                "costing_options": self._costing(),
                "units": "kilometers",
            },
        )
        rows = payload.get("sources_to_targets")
        if not isinstance(rows, list):
            raise RuntimeError("Valhalla matrix response is missing sources_to_targets.")
        costs: list[MatrixCost] = []
        for source_index, row in enumerate(rows):
            if not isinstance(row, list):
                continue
            for target_index, item in enumerate(row):
                if not isinstance(item, dict) or item.get("time") is None or item.get("distance") is None:
                    continue
                costs.append(
                    MatrixCost(
                        source_index=int(item.get("from_index", source_index)),
                        target_index=int(item.get("to_index", target_index)),
                        duration_seconds=float(item["time"]),
                        distance_m=float(item["distance"]) * 1000,
                    )
                )
        return costs

    def route(self, origin: tuple[float, float], destination: tuple[float, float]) -> ValhallaRoute:
        payload = self._post(
            "route",
            {
                "locations": [self._location(origin), self._location(destination)],
                "costing": "bicycle",
                "costing_options": self._costing(),
                "directions_options": {"units": "kilometers", "language": "en-US"},
            },
        )
        trip = payload.get("trip")
        if not isinstance(trip, dict) or not isinstance(trip.get("legs"), list):
            raise RuntimeError("Valhalla route response is missing trip legs.")

        coordinates: list[list[float]] = []
        steps: list[dict[str, Any]] = []
        street_names: list[str] = []
        for leg in trip["legs"]:
            if not isinstance(leg, dict) or not isinstance(leg.get("shape"), str):
                continue
            leg_coordinates = decode_polyline(leg["shape"])
            coordinate_offset = len(coordinates) - 1 if coordinates else 0
            coordinates.extend(leg_coordinates[1:] if coordinates and leg_coordinates else leg_coordinates)
            for maneuver in leg.get("maneuvers", []):
                if not isinstance(maneuver, dict):
                    continue
                names = maneuver.get("street_names") or []
                street_name = str(names[0]) if isinstance(names, list) and names else ""
                if street_name and street_name not in street_names:
                    street_names.append(street_name)
                begin_index = min(
                    max(0, int(maneuver.get("begin_shape_index", 0)) + coordinate_offset),
                    max(0, len(coordinates) - 1),
                )
                steps.append(
                    {
                        "instruction": str(maneuver.get("instruction") or "Continue"),
                        "maneuver": maneuver_name(maneuver.get("type")),
                        "street_name": street_name,
                        "distance_m": round(float(maneuver.get("length", 0)) * 1000),
                        "coordinate": coordinates[begin_index] if coordinates else [origin[1], origin[0]],
                        "edge_keys": [],
                    }
                )

        summary = trip.get("summary") or {}
        if not coordinates:
            raise RuntimeError("Valhalla route response contains no geometry.")
        return ValhallaRoute(
            distance_m=round(float(summary.get("length", 0)) * 1000),
            duration_seconds=float(summary.get("time", 0)),
            coordinates=coordinates,
            steps=steps,
            sample_streets=street_names[:8],
        )


def decode_polyline(value: str, precision: int = 6) -> list[list[float]]:
    """Decode Valhalla's encoded shape into GeoJSON [longitude, latitude] coordinates."""
    coordinates: list[list[float]] = []
    latitude = longitude = index = 0
    factor = 10**precision
    while index < len(value):
        deltas: list[int] = []
        for _ in range(2):
            result = shift = 0
            while True:
                if index >= len(value):
                    raise RuntimeError("Valhalla returned a malformed encoded shape.")
                byte = ord(value[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        latitude += deltas[0]
        longitude += deltas[1]
        coordinates.append([longitude / factor, latitude / factor])
    return coordinates


def maneuver_name(value: Any) -> str:
    try:
        maneuver_type = int(value)
    except (TypeError, ValueError):
        return "continue"
    if maneuver_type in {1, 2, 3}:
        return "start"
    if maneuver_type in {4, 5, 6}:
        return "arrive"
    if maneuver_type in {9, 10, 11, 17, 18, 19, 20}:
        return "right"
    if maneuver_type in {14, 15, 16, 21, 22, 23, 24}:
        return "left"
    if maneuver_type in {12, 13}:
        return "uturn"
    return "continue"


def bixi_valhalla_plan(
    args: Any,
    walk_graph: nx.MultiDiGraph,
    client: ValhallaClient,
    option_limit: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    stations = load_bixi_stations(args.bixi_gbfs_url, args.gbfs_language)
    max_walk_m = args.max_walk_minutes * WALKING_SPEED_M_PER_MIN
    pickups = walking_station_candidates(
        walk_graph, stations, args.origin, max_walk_m, "pickup", args.bike_preference, args.station_candidate_limit
    )
    dropoffs = walking_station_candidates(
        walk_graph, stations, args.destination, max_walk_m, "dropoff", args.bike_preference, args.station_candidate_limit
    )
    all_pickups = pickups
    all_dropoffs = dropoffs
    if args.pickup_station_id:
        pickups = [station for station in pickups if station["station_id"] == args.pickup_station_id]
    if args.dropoff_station_id:
        dropoffs = [station for station in dropoffs if station["station_id"] == args.dropoff_station_id]

    if not pickups:
        nearby = nearest_station_snapshot(stations, args.origin, "pickup", args.bike_preference)
        raise RuntimeError(f"No usable BIXI pickup stations within {args.max_walk_minutes} minutes of origin. Nearest stations: {nearby}")
    if not dropoffs:
        nearby = nearest_station_snapshot(stations, args.destination, "dropoff", args.bike_preference)
        raise RuntimeError(f"No usable BIXI dropoff stations within {args.max_walk_minutes} minutes of destination. Nearest stations: {nearby}")

    matrix = client.matrix([station["point"] for station in pickups], [station["point"] for station in dropoffs])
    ranked: list[tuple[float, MatrixCost]] = []
    for cost in matrix:
        if cost.source_index >= len(pickups) or cost.target_index >= len(dropoffs) or not math.isfinite(cost.duration_seconds):
            continue
        pickup = pickups[cost.source_index]
        dropoff = dropoffs[cost.target_index]
        bike_equivalent_m = cost.duration_seconds * CYCLING_SPEED_M_PER_MIN / 60
        ranked.append((pickup["station_score"] + dropoff["station_score"] + bike_equivalent_m, cost))

    results: list[dict[str, Any]] = []
    for total_score, cost in sorted(ranked, key=lambda item: item[0]):
        pickup = pickups[cost.source_index]
        dropoff = dropoffs[cost.target_index]
        try:
            route = client.route(pickup["point"], dropoff["point"])
        except RuntimeError:
            continue
        results.append(
            {
                "pickup": pickup,
                "dropoff": dropoff,
                "valhalla_route": route,
                "total_score": total_score,
                "total_walk_m": pickup["walk_distance_m"] + dropoff["walk_distance_m"],
            }
        )
        if len(results) >= option_limit:
            break
    if not results:
        raise RuntimeError("Valhalla could not route between any BIXI pickup/dropoff candidate pair.")
    return results, all_pickups, all_dropoffs


def bixi_valhalla_option_payload(result: dict[str, Any], walk_graph: nx.MultiDiGraph) -> dict[str, Any]:
    pickup = result["pickup"]
    dropoff = result["dropoff"]
    route: ValhallaRoute = result["valhalla_route"]
    estimated_total_minutes = round(
        pickup["walk_distance_m"] / WALKING_SPEED_M_PER_MIN
        + route.duration_seconds / 60
        + dropoff["walk_distance_m"] / WALKING_SPEED_M_PER_MIN
    )
    return {
        "estimated_total_minutes": estimated_total_minutes,
        "total_walk_m": result["total_walk_m"],
        "comfort_score": None,
        "pickup": station_payload(pickup, "pickup"),
        "dropoff": station_payload(dropoff, "dropoff"),
        "legs": {
            "walk_to_pickup": {
                "distance_m": pickup["walk_distance_m"],
                "coordinates": route_points(walk_graph, pickup["walk_route"], "shortest_cost"),
                "steps": route_maneuvers(walk_graph, pickup["walk_route"], "shortest_cost"),
            },
            "bike": {
                "distance_m": route.distance_m,
                "coordinates": route.coordinates,
                "steps": route.steps,
                "sample_streets": route.sample_streets,
            },
            "walk_to_destination": {
                "distance_m": dropoff["walk_distance_m"],
                "coordinates": route_points(walk_graph, dropoff["walk_route"], "shortest_cost"),
                "steps": route_maneuvers(walk_graph, dropoff["walk_route"], "shortest_cost"),
            },
        },
    }


def station_payload(station: dict[str, Any], kind: str) -> dict[str, Any]:
    payload = {
        "station_id": station["station_id"],
        "name": station["name"],
        "coordinates": [station["point"][1], station["point"][0]],
        "walk_distance_m": station["walk_distance_m"],
        "availability_updated_at": None,
    }
    if station.get("last_reported"):
        from detour_router import iso_timestamp

        payload["availability_updated_at"] = iso_timestamp(station["last_reported"])
    if kind == "pickup":
        payload.update(
            available_bikes=int(station.get("num_bikes_available", 0)),
            available_regular_bikes=int(station.get("available_regular_bikes", 0)),
            available_ebikes=int(station.get("num_ebikes_available", 0)),
        )
    else:
        payload["available_docks"] = int(station.get("num_docks_available", 0))
    return payload
