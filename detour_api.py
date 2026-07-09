"""HTTP API for the Détour routing experiment."""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
from functools import lru_cache
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from detour_router import (
    DEFAULT_BIXI_GBFS_URL,
    DEFAULT_DESTINATION,
    DEFAULT_ORIGIN,
    bixi_option_payload,
    bixi_route_options,
    load_graph,
    parse_lat_lon,
)


app = FastAPI(title="Detour API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_methods=["GET"],
    allow_headers=[],
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


@lru_cache(maxsize=16)
def graphs_for_route(origin: tuple[float, float], destination: tuple[float, float]):
    args = router_args(origin, destination, "any", 15)
    return load_graph(args, "bike"), load_graph(args, "walk")


def parse_point(value: str, field_name: str) -> tuple[float, float]:
    try:
        return parse_lat_lon(value)
    except (argparse.ArgumentTypeError, ValueError, TypeError) as error:
        raise HTTPException(status_code=422, detail=f"Invalid {field_name}: {error}") from error


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "detour-api"}


@app.get("/v1/routes/bixi")
def bixi_routes(
    origin: str = Query(default=f"{DEFAULT_ORIGIN[0]},{DEFAULT_ORIGIN[1]}"),
    destination: str = Query(default=f"{DEFAULT_DESTINATION[0]},{DEFAULT_DESTINATION[1]}"),
    bike_preference: str = Query(default="any", pattern="^(any|ebike|regular)$"),
    max_walk_minutes: float = Query(default=15, gt=0, le=30),
    options: int = Query(default=3, ge=1, le=5),
) -> dict:
    parsed_origin = parse_point(origin, "origin")
    parsed_destination = parse_point(destination, "destination")
    args = router_args(parsed_origin, parsed_destination, bike_preference, max_walk_minutes)
    bike_graph, walk_graph = graphs_for_route(parsed_origin, parsed_destination)

    try:
        results = bixi_route_options(args, bike_graph, walk_graph, option_limit=options)
    except RuntimeError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    return {
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "mode": "bixi",
        "origin": {"coordinates": [parsed_origin[1], parsed_origin[0]]},
        "destination": {"coordinates": [parsed_destination[1], parsed_destination[0]]},
        "bike_preference": bike_preference,
        "max_walk_minutes": max_walk_minutes,
        "options": [bixi_option_payload(result, bike_graph, walk_graph) for result in results],
    }
