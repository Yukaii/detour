"""HTTP API for the Détour routing experiment."""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import time
import urllib.parse
import urllib.request
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
from typing import Any, Callable
from urllib.error import HTTPError, URLError

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware

from detour_router import (
    DEFAULT_BIXI_GBFS_URL,
    DEFAULT_DESTINATION,
    DEFAULT_ORIGIN,
    MONTREAL_BBOX,
    bixi_option_payload,
    bixi_route_plan,
    bixi_route_options,
    load_bixi_stations,
    load_prepared_graph,
    parse_lat_lon,
    route_edge_sequence,
)
from traffic_restrictions import RestrictionSnapshot, TrafficRestrictionProvider, restriction_weight


logger = logging.getLogger("detour.api")


def env_int(name: str, default: int, minimum: int = 1) -> int:
    value = int(os.getenv(name, str(default)))
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}.")
    return value


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name, str(default)).strip().lower()
    if value not in {"1", "0", "true", "false", "yes", "no", "on", "off"}:
        raise ValueError(f"{name} must be a boolean value.")
    return value in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    cors_origins: tuple[str, ...]
    route_cache_ttl_seconds: int
    places_cache_ttl_seconds: int
    rate_limit_per_minute: int
    max_route_distance_km: int
    graph_manifest_path: Path
    photon_url: str
    traffic_restrictions_enabled: bool
    traffic_restrictions_url: str
    traffic_restrictions_ttl_seconds: int
    traffic_restrictions_stale_seconds: int

    @classmethod
    def from_env(cls) -> "Settings":
        origins = tuple(
            origin.strip()
            for origin in os.getenv("DETOUR_CORS_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000").split(",")
            if origin.strip()
        )
        return cls(
            cors_origins=origins,
            route_cache_ttl_seconds=env_int("DETOUR_ROUTE_CACHE_TTL_SECONDS", 60),
            places_cache_ttl_seconds=env_int("DETOUR_PLACES_CACHE_TTL_SECONDS", 300),
            rate_limit_per_minute=env_int("DETOUR_RATE_LIMIT_PER_MINUTE", 30),
            max_route_distance_km=env_int("DETOUR_MAX_ROUTE_DISTANCE_KM", 35),
            graph_manifest_path=Path(os.getenv("DETOUR_GRAPH_MANIFEST_PATH", "data/graphs/manifest.json")),
            photon_url=os.getenv("DETOUR_PHOTON_URL", "https://photon.komoot.io").rstrip("/"),
            traffic_restrictions_enabled=env_bool("DETOUR_TRAFFIC_RESTRICTIONS_ENABLED", False),
            traffic_restrictions_url=os.getenv("DETOUR_TRAFFIC_RESTRICTIONS_URL", ""),
            traffic_restrictions_ttl_seconds=env_int("DETOUR_TRAFFIC_RESTRICTIONS_TTL_SECONDS", 90),
            traffic_restrictions_stale_seconds=env_int("DETOUR_TRAFFIC_RESTRICTIONS_STALE_SECONDS", 300),
        )


@dataclass
class CacheEntry:
    value: dict[str, Any]
    expires_at: float


class TtlCache:
    def __init__(self) -> None:
        self._entries: dict[tuple[Any, ...], CacheEntry] = {}
        self._lock = Lock()

    def get_or_set(self, key: tuple[Any, ...], ttl_seconds: int, factory: Callable[[], dict[str, Any]]) -> tuple[dict[str, Any], bool]:
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry and entry.expires_at > now:
                return entry.value, True
            value = factory()
            self._entries[key] = CacheEntry(value=value, expires_at=now + ttl_seconds)
            return value, False


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: FastAPI, requests_per_minute: int) -> None:
        super().__init__(app)
        self.requests_per_minute = requests_per_minute
        self._requests: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        if request.url.path in {"/health", "/ready"}:
            return await call_next(request)
        client = request.client.host if request.client else "unknown"
        now = time.monotonic()
        with self._lock:
            timestamps = self._requests[client]
            while timestamps and timestamps[0] <= now - 60:
                timestamps.popleft()
            if len(timestamps) >= self.requests_per_minute:
                retry_after = max(1, int(60 - (now - timestamps[0])))
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Rate limit exceeded. Try again shortly."},
                    headers={"Retry-After": str(retry_after)},
                )
            timestamps.append(now)
        return await call_next(request)


class RequestLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        started_at = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - started_at) * 1000, 1)
        response.headers["X-Request-ID"] = request_id
        logger.info(
            json.dumps(
                {
                    "event": "request_completed",
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status_code": response.status_code,
                    "duration_ms": duration_ms,
                }
            )
        )
        return response


settings = Settings.from_env()
route_cache = TtlCache()
places_cache = TtlCache()
stations_cache = TtlCache()
traffic_restrictions = TrafficRestrictionProvider(
    enabled=settings.traffic_restrictions_enabled,
    url=settings.traffic_restrictions_url,
    ttl_seconds=settings.traffic_restrictions_ttl_seconds,
    stale_seconds=settings.traffic_restrictions_stale_seconds,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    started_at = time.perf_counter()
    prepared_graphs()
    logger.info(
        json.dumps(
            {
                "event": "graphs_loaded",
                "duration_ms": round((time.perf_counter() - started_at) * 1000, 1),
            }
        )
    )
    yield


app = FastAPI(title="Detour API", version="0.3.0", lifespan=lifespan)
app.add_middleware(RateLimitMiddleware, requests_per_minute=settings.rate_limit_per_minute)
app.add_middleware(RequestLogMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_methods=["GET"],
    allow_headers=["X-Request-ID"],
)


def router_args(
    origin: tuple[float, float],
    destination: tuple[float, float],
    bike_preference: str,
    max_walk_minutes: float,
    pickup_station_id: str | None = None,
    dropoff_station_id: str | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        origin=origin,
        destination=destination,
        bike_preference=bike_preference,
        max_walk_minutes=max_walk_minutes,
        station_candidate_limit=8,
        bixi_gbfs_url=DEFAULT_BIXI_GBFS_URL,
        gbfs_language="en",
        bbox_buffer_km=1.5,
        place="",
        graph_cache="",
        mode="bixi",
        pickup_station_id=pickup_station_id,
        dropoff_station_id=dropoff_station_id,
    )


def load_graph_manifest(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError(f"Prepared graph manifest is missing or empty: {path}")
    try:
        manifest = json.loads(path.read_text())
        bounds = manifest["bounds"]
        files = manifest["files"]
        for key in ("south", "west", "north", "east"):
            float(bounds[key])
        for key in ("bike", "walk"):
            if not files[key]:
                raise ValueError(f"Missing {key} graph filename")
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Prepared graph manifest is invalid: {path}: {error}") from error
    return manifest


def graph_artifact_paths() -> tuple[dict[str, Any], Path, Path]:
    manifest = load_graph_manifest(settings.graph_manifest_path)
    directory = settings.graph_manifest_path.parent
    bike_path = directory / manifest["files"]["bike"]
    walk_path = directory / manifest["files"]["walk"]
    for network_type, path in (("bike", bike_path), ("walk", walk_path)):
        if not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError(f"Prepared {network_type} graph is missing or empty: {path}")
    return manifest, bike_path, walk_path


@lru_cache(maxsize=1)
def prepared_graphs():
    _, bike_path, walk_path = graph_artifact_paths()
    return load_prepared_graph(bike_path, "bike"), load_prepared_graph(walk_path, "walk")


def parse_point(value: str, field_name: str) -> tuple[float, float]:
    try:
        return parse_lat_lon(value)
    except (argparse.ArgumentTypeError, ValueError, TypeError) as error:
        raise HTTPException(status_code=422, detail=f"Invalid {field_name}: {error}") from error


def distance_km(first: tuple[float, float], second: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, first)
    lat2, lon2 = map(math.radians, second)
    delta_lat = lat2 - lat1
    delta_lon = lon2 - lon1
    haversine = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 6371.0088 * 2 * math.asin(math.sqrt(haversine))


def validate_route_request(origin: tuple[float, float], destination: tuple[float, float]) -> None:
    for field_name, (latitude, longitude) in (("origin", origin), ("destination", destination)):
        if not (
            MONTREAL_BBOX["min_lat"] <= latitude <= MONTREAL_BBOX["max_lat"]
            and MONTREAL_BBOX["min_lon"] <= longitude <= MONTREAL_BBOX["max_lon"]
        ):
            raise HTTPException(status_code=422, detail=f"{field_name} is outside the Montréal service area.")

    if distance_km(origin, destination) > settings.max_route_distance_km:
        raise HTTPException(
            status_code=422,
            detail=f"Route exceeds the {settings.max_route_distance_km} km maximum straight-line distance.",
        )

    try:
        manifest, _, _ = graph_artifact_paths()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    bounds = manifest["bounds"]
    for field_name, (latitude, longitude) in (("origin", origin), ("destination", destination)):
        if not (
            float(bounds["south"]) <= latitude <= float(bounds["north"])
            and float(bounds["west"]) <= longitude <= float(bounds["east"])
        ):
            raise HTTPException(status_code=422, detail=f"{field_name} is outside the prepared routing coverage.")


def bixi_response(
    origin: tuple[float, float],
    destination: tuple[float, float],
    bike_preference: str,
    max_walk_minutes: float,
    options: int,
    pickup_station_id: str | None = None,
    dropoff_station_id: str | None = None,
    restriction_snapshot: RestrictionSnapshot | None = None,
) -> dict[str, Any]:
    args = router_args(origin, destination, bike_preference, max_walk_minutes, pickup_station_id, dropoff_station_id)
    bike_graph, walk_graph = prepared_graphs()
    restriction_snapshot = restriction_snapshot or traffic_restrictions.snapshot(bike_graph)
    bike_weight = restriction_weight("bike_path_first_cost", restriction_snapshot)
    results, pickups, dropoffs = bixi_route_plan(
        args, bike_graph, walk_graph, option_limit=options, bike_weight=bike_weight
    )
    route_edges = {
        (u, v, key)
        for result in results
        for u, v, key, _ in route_edge_sequence(bike_graph, result["route"], bike_weight)
    }
    def station_payload(station: dict[str, Any], kind: str) -> dict[str, Any]:
        return {
            "station_id": station["station_id"],
            "name": station["name"],
            "coordinates": [station["point"][1], station["point"][0]],
            "walk_distance_m": station["walk_distance_m"],
            "available_bikes": int(station.get("num_bikes_available", 0)),
            "available_regular_bikes": int(station.get("available_regular_bikes", 0)),
            "available_ebikes": int(station.get("num_ebikes_available", 0)),
            "available_docks": int(station.get("num_docks_available", 0)),
            "availability_updated_at": datetime.fromtimestamp(float(station["last_reported"]), tz=UTC).isoformat().replace("+00:00", "Z") if station.get("last_reported") else None,
            "kind": kind,
        }
    return {
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "mode": "bixi",
        "origin": {"coordinates": [origin[1], origin[0]]},
        "destination": {"coordinates": [destination[1], destination[0]]},
        "bike_preference": bike_preference,
        "max_walk_minutes": max_walk_minutes,
        "options": [bixi_option_payload(result, bike_graph, walk_graph) for result in results],
        "nearby_stations": [station_payload(station, "pickup") for station in pickups]
        + [station_payload(station, "dropoff") for station in dropoffs],
        "traffic_restrictions": restriction_snapshot.payload(route_edges),
    }


def bixi_stations_response() -> dict[str, Any]:
    """Return the live BIXI network for the station explorer."""
    stations = load_bixi_stations(DEFAULT_BIXI_GBFS_URL, "en")
    return {
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "stations": [
            {
                "station_id": station["station_id"],
                "name": station["name"],
                "coordinates": [station["point"][1], station["point"][0]],
                "available_bikes": int(station.get("num_bikes_available", 0)),
                "available_regular_bikes": int(station.get("available_regular_bikes", 0)),
                "available_ebikes": int(station.get("num_ebikes_available", 0)),
                "available_docks": int(station.get("num_docks_available", 0)),
                "is_renting": bool(station.get("is_renting")),
                "is_returning": bool(station.get("is_returning")),
                "availability_updated_at": datetime.fromtimestamp(float(station["last_reported"]), tz=UTC).isoformat().replace("+00:00", "Z") if station.get("last_reported") else None,
            }
            for station in stations
        ],
    }


def coverage_bounds() -> dict[str, float] | None:
    try:
        manifest, _, _ = graph_artifact_paths()
    except RuntimeError:
        return None
    bounds = manifest["bounds"]
    return {
        "south": float(bounds["south"]),
        "west": float(bounds["west"]),
        "north": float(bounds["north"]),
        "east": float(bounds["east"]),
    }


def point_in_coverage(latitude: float, longitude: float) -> bool:
    bounds = coverage_bounds()
    if bounds is None:
        return (
            MONTREAL_BBOX["min_lat"] <= latitude <= MONTREAL_BBOX["max_lat"]
            and MONTREAL_BBOX["min_lon"] <= longitude <= MONTREAL_BBOX["max_lon"]
        )
    return (
        bounds["south"] <= latitude <= bounds["north"]
        and bounds["west"] <= longitude <= bounds["east"]
    )


def format_photon_place(feature: dict[str, Any]) -> dict[str, Any] | None:
    geometry = feature.get("geometry") or {}
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        return None
    longitude = float(coordinates[0])
    latitude = float(coordinates[1])
    props = feature.get("properties") or {}
    street_line = " ".join(part for part in (props.get("housenumber"), props.get("street")) if part)
    name = str(props.get("name") or street_line or props.get("locality") or props.get("city") or "Selected place")
    detail = (
        props.get("district")
        or props.get("locality")
        or props.get("city")
        or props.get("street")
        or props.get("state")
        or "Montréal"
    )
    osm_type = props.get("osm_type") or "n"
    osm_id = props.get("osm_id") or f"{latitude:.5f},{longitude:.5f}"
    return {
        "id": f"{osm_type}-{osm_id}",
        "name": name,
        "detail": detail,
        "coordinate": [longitude, latitude],
        "in_coverage": point_in_coverage(latitude, longitude),
    }


def photon_get(path: str, params: dict[str, str]) -> Any:
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{settings.photon_url}{path}?{query}",
        headers={"Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise RuntimeError(f"Photon returned HTTP {error.code}") from error
    except (URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RuntimeError(f"Photon request failed: {error}") from error


def search_places(query: str, limit: int) -> dict[str, Any]:
    term = query.strip()
    if len(term) < 2:
        return {"query": term, "results": []}

    # Bias toward central Montréal; Photon also tolerates typos better than Nominatim.
    payload = photon_get(
        "/api/",
        {
            "q": term,
            "limit": str(max(limit, 12)),
            "lang": "en",
            "lat": "45.521",
            "lon": "-73.595",
            "bbox": (
                f"{MONTREAL_BBOX['min_lon']},{MONTREAL_BBOX['min_lat']},"
                f"{MONTREAL_BBOX['max_lon']},{MONTREAL_BBOX['max_lat']}"
            ),
        },
    )
    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list):
        raise RuntimeError("Photon search returned an unexpected payload.")

    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for feature in features:
        if not isinstance(feature, dict):
            continue
        place = format_photon_place(feature)
        if place is None or place["id"] in seen:
            continue
        seen.add(place["id"])
        results.append(place)

    covered = [item for item in results if item["in_coverage"]]
    ordered = covered + [item for item in results if not item["in_coverage"]]
    return {"query": term, "results": ordered[:limit], "coverage": coverage_bounds()}


def reverse_place(latitude: float, longitude: float) -> dict[str, Any]:
    payload = photon_get(
        "/reverse",
        {
            "lat": f"{latitude:.6f}",
            "lon": f"{longitude:.6f}",
            "lang": "en",
        },
    )
    features = payload.get("features") if isinstance(payload, dict) else None
    if isinstance(features, list) and features:
        place = format_photon_place(features[0]) if isinstance(features[0], dict) else None
        if place is not None:
            return place
    return {
        "id": f"{latitude:.5f},{longitude:.5f}",
        "name": "Dropped pin",
        "detail": "Selected on map",
        "coordinate": [longitude, latitude],
        "in_coverage": point_in_coverage(latitude, longitude),
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "detour-api"}


@app.get("/ready")
def ready() -> JSONResponse:
    try:
        manifest, _, _ = graph_artifact_paths()
        prepared_graphs()
    except RuntimeError as error:
        return JSONResponse(status_code=503, content={"status": "not_ready", "service": "detour-api", "detail": str(error)})
    return JSONResponse(
        content={
            "status": "ready",
            "service": "detour-api",
            "graph_version": manifest.get("version", "unknown"),
            "generated_at": manifest.get("generated_at"),
        }
    )


@app.get("/v1/routes/bixi")
def bixi_routes(
    origin: str = Query(default=f"{DEFAULT_ORIGIN[0]},{DEFAULT_ORIGIN[1]}"),
    destination: str = Query(default=f"{DEFAULT_DESTINATION[0]},{DEFAULT_DESTINATION[1]}"),
    bike_preference: str = Query(default="any", pattern="^(any|ebike|regular)$"),
    max_walk_minutes: float = Query(default=15, gt=0, le=30),
    options: int = Query(default=3, ge=1, le=5),
    pickup_station_id: str | None = Query(default=None, max_length=80),
    dropoff_station_id: str | None = Query(default=None, max_length=80),
) -> JSONResponse:
    parsed_origin = parse_point(origin, "origin")
    parsed_destination = parse_point(destination, "destination")
    validate_route_request(parsed_origin, parsed_destination)
    try:
        bike_graph = prepared_graphs()[0] if traffic_restrictions.enabled else None
        restriction_snapshot = traffic_restrictions.snapshot(bike_graph)
        cache_key = (
            parsed_origin, parsed_destination, bike_preference, max_walk_minutes, options,
            pickup_station_id, dropoff_station_id, restriction_snapshot.version,
        )
        payload, cache_hit = route_cache.get_or_set(
            cache_key,
            settings.route_cache_ttl_seconds,
            lambda: bixi_response(
                parsed_origin, parsed_destination, bike_preference, max_walk_minutes, options,
                pickup_station_id, dropoff_station_id, restriction_snapshot,
            ),
        )
    except (RuntimeError, TimeoutError, URLError) as error:
        raise HTTPException(status_code=503, detail=f"Routing data is temporarily unavailable: {error}") from error

    return JSONResponse(
        content=payload,
        headers={
            "Cache-Control": f"private, max-age={settings.route_cache_ttl_seconds}",
            "X-Detour-Cache": "HIT" if cache_hit else "MISS",
        },
    )


@app.get("/v1/stations/bixi")
def bixi_stations() -> JSONResponse:
    try:
        payload, cache_hit = stations_cache.get_or_set(
            ("bixi_stations",), settings.route_cache_ttl_seconds, bixi_stations_response
        )
    except (RuntimeError, TimeoutError, URLError) as error:
        raise HTTPException(status_code=503, detail=f"Station data is temporarily unavailable: {error}") from error
    return JSONResponse(
        content=payload,
        headers={"Cache-Control": f"private, max-age={settings.route_cache_ttl_seconds}", "X-Detour-Cache": "HIT" if cache_hit else "MISS"},
    )


@app.get("/v1/places/search")
def places_search(
    q: str = Query(min_length=1, max_length=120),
    limit: int = Query(default=8, ge=1, le=12),
) -> JSONResponse:
    cache_key = ("places_search", q.strip().lower(), limit)
    try:
        payload, cache_hit = places_cache.get_or_set(
            cache_key,
            settings.places_cache_ttl_seconds,
            lambda: search_places(q, limit),
        )
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=f"Place search is temporarily unavailable: {error}") from error

    return JSONResponse(
        content=payload,
        headers={
            "Cache-Control": f"private, max-age={settings.places_cache_ttl_seconds}",
            "X-Detour-Cache": "HIT" if cache_hit else "MISS",
        },
    )


@app.get("/v1/places/reverse")
def places_reverse(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
) -> JSONResponse:
    cache_key = ("places_reverse", round(lat, 5), round(lon, 5))
    try:
        payload, cache_hit = places_cache.get_or_set(
            cache_key,
            settings.places_cache_ttl_seconds,
            lambda: reverse_place(lat, lon),
        )
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=f"Reverse geocoding is temporarily unavailable: {error}") from error

    return JSONResponse(
        content=payload,
        headers={
            "Cache-Control": f"private, max-age={settings.places_cache_ttl_seconds}",
            "X-Detour-Cache": "HIT" if cache_hit else "MISS",
        },
    )
