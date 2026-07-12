"""HTTP API for the Détour routing experiment."""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import time
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
from urllib.error import URLError

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
    bixi_route_options,
    load_prepared_graph,
    parse_lat_lon,
)


logger = logging.getLogger("detour.api")


def env_int(name: str, default: int, minimum: int = 1) -> int:
    value = int(os.getenv(name, str(default)))
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}.")
    return value


@dataclass(frozen=True)
class Settings:
    cors_origins: tuple[str, ...]
    route_cache_ttl_seconds: int
    rate_limit_per_minute: int
    max_route_distance_km: int
    graph_manifest_path: Path

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
            rate_limit_per_minute=env_int("DETOUR_RATE_LIMIT_PER_MINUTE", 30),
            max_route_distance_km=env_int("DETOUR_MAX_ROUTE_DISTANCE_KM", 35),
            graph_manifest_path=Path(os.getenv("DETOUR_GRAPH_MANIFEST_PATH", "data/graphs/manifest.json")),
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
) -> dict[str, Any]:
    args = router_args(origin, destination, bike_preference, max_walk_minutes)
    bike_graph, walk_graph = prepared_graphs()
    results = bixi_route_options(args, bike_graph, walk_graph, option_limit=options)
    return {
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "mode": "bixi",
        "origin": {"coordinates": [origin[1], origin[0]]},
        "destination": {"coordinates": [destination[1], destination[0]]},
        "bike_preference": bike_preference,
        "max_walk_minutes": max_walk_minutes,
        "options": [bixi_option_payload(result, bike_graph, walk_graph) for result in results],
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
) -> JSONResponse:
    parsed_origin = parse_point(origin, "origin")
    parsed_destination = parse_point(destination, "destination")
    validate_route_request(parsed_origin, parsed_destination)
    cache_key = (parsed_origin, parsed_destination, bike_preference, max_walk_minutes, options)

    try:
        payload, cache_hit = route_cache.get_or_set(
            cache_key,
            settings.route_cache_ttl_seconds,
            lambda: bixi_response(parsed_origin, parsed_destination, bike_preference, max_walk_minutes, options),
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
