#!/usr/bin/env python3
"""Détour Montréal bike-routing experiment.

Fetches an OpenStreetMap bike graph, classifies edges by bike-friendliness,
and writes shortest-vs-comfort route GeoJSON for manual inspection.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

import networkx as nx
import osmnx as ox


MONTREAL_BBOX = {
    "min_lat": 45.40,
    "max_lat": 45.71,
    "min_lon": -73.99,
    "max_lon": -73.47,
}

DEFAULT_ORIGIN = (45.50884, -73.58781)  # Place des Arts
DEFAULT_DESTINATION = (45.53535, -73.62022)  # near Parc Martin-Luther-King

CLASS_MULTIPLIERS = {
    "separated_path": 0.72,
    "protected_lane": 0.78,
    "painted_bike_lane": 0.90,
    "quiet_street": 1.00,
    "minor_mixed": 1.25,
    "major_mixed": 2.10,
    "high_speed_arterial": 2.85,
    "unknown": 1.40,
}

ROUTE_STYLES = {
    "shortest": {"stroke": "#ef4444", "stroke-width": 5, "stroke-opacity": 0.78},
    "bike_path_first": {"stroke": "#2563eb", "stroke-width": 6, "stroke-opacity": 0.9},
}


def parse_lat_lon(value: str) -> tuple[float, float]:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("Use 'lat,lon', for example '45.50884,-73.58781'.")
    lat, lon = float(parts[0]), float(parts[1])
    if not (MONTREAL_BBOX["min_lat"] <= lat <= MONTREAL_BBOX["max_lat"]):
        raise argparse.ArgumentTypeError(f"Latitude {lat} is outside the Montréal MVP bounds.")
    if not (MONTREAL_BBOX["min_lon"] <= lon <= MONTREAL_BBOX["max_lon"]):
        raise argparse.ArgumentTypeError(f"Longitude {lon} is outside the Montréal MVP bounds.")
    return lat, lon


def first_tag(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return str(value[0]).lower() if value else ""
    return str(value).lower()


def any_tag(data: dict[str, Any], *keys: str) -> set[str]:
    values: set[str] = set()
    for key in keys:
        value = data.get(key)
        if isinstance(value, list):
            values.update(str(item).lower() for item in value)
        elif value is not None:
            values.add(str(value).lower())
    return values


def parse_speed_kmh(value: Any) -> float | None:
    raw = first_tag(value)
    if not raw:
        return None
    digits = "".join(char if char.isdigit() or char == "." else " " for char in raw).split()
    if not digits:
        return None
    speed = float(digits[0])
    if "mph" in raw:
        speed *= 1.60934
    return speed


def classify_edge(data: dict[str, Any]) -> tuple[str, float]:
    highway = first_tag(data.get("highway"))
    cycle_tags = any_tag(data, "cycleway", "cycleway:left", "cycleway:right", "cycleway:both")
    bicycle = first_tag(data.get("bicycle"))
    maxspeed = parse_speed_kmh(data.get("maxspeed"))

    if highway in {"cycleway"} or (
        highway in {"path", "track"} and bicycle in {"yes", "designated", "official", "permissive"}
    ):
        return "separated_path", CLASS_MULTIPLIERS["separated_path"]

    if cycle_tags & {"track", "opposite_track", "separate", "protected_lane"}:
        return "protected_lane", CLASS_MULTIPLIERS["protected_lane"]

    if cycle_tags & {"lane", "opposite_lane", "shared_lane", "shoulder"}:
        return "painted_bike_lane", CLASS_MULTIPLIERS["painted_bike_lane"]

    if highway in {"living_street", "residential"}:
        return "quiet_street", CLASS_MULTIPLIERS["quiet_street"]

    if highway in {"service", "unclassified"}:
        return "minor_mixed", CLASS_MULTIPLIERS["minor_mixed"]

    if highway in {"primary", "primary_link", "secondary", "secondary_link", "trunk", "trunk_link"}:
        if maxspeed is not None and maxspeed >= 50:
            return "high_speed_arterial", CLASS_MULTIPLIERS["high_speed_arterial"]
        return "major_mixed", CLASS_MULTIPLIERS["major_mixed"]

    if highway in {"tertiary", "tertiary_link"}:
        return "major_mixed", CLASS_MULTIPLIERS["major_mixed"]

    return "unknown", CLASS_MULTIPLIERS["unknown"]


def add_detour_weights(graph: nx.MultiDiGraph) -> None:
    for _, _, _, data in graph.edges(keys=True, data=True):
        length = float(data.get("length", 1.0))
        infra_class, multiplier = classify_edge(data)
        data["detour_class"] = infra_class
        data["detour_multiplier"] = multiplier
        data["shortest_cost"] = length
        data["bike_path_first_cost"] = length * multiplier


def configure_osmnx() -> None:
    ox.settings.use_cache = True
    ox.settings.log_console = True
    useful = set(ox.settings.useful_tags_way)
    useful.update(
        {
            "bicycle",
            "cycleway",
            "cycleway:left",
            "cycleway:right",
            "cycleway:both",
            "lanes",
            "maxspeed",
            "oneway",
            "oneway:bicycle",
            "segregated",
            "surface",
        }
    )
    ox.settings.useful_tags_way = list(useful)


def route_bbox(origin: tuple[float, float], destination: tuple[float, float], buffer_km: float) -> tuple[float, float, float, float]:
    lat_buffer = buffer_km / 111.0
    mean_lat = math.radians((origin[0] + destination[0]) / 2)
    lon_buffer = buffer_km / (111.0 * max(math.cos(mean_lat), 0.1))
    left = min(origin[1], destination[1]) - lon_buffer
    right = max(origin[1], destination[1]) + lon_buffer
    bottom = min(origin[0], destination[0]) - lat_buffer
    top = max(origin[0], destination[0]) + lat_buffer
    return left, bottom, right, top


def default_cache_path(args: argparse.Namespace) -> Path:
    if args.place:
        slug = "".join(char.lower() if char.isalnum() else "-" for char in args.place).strip("-")
        return Path("data") / f"{slug or 'place'}-bike.graphml"

    bbox = route_bbox(args.origin, args.destination, args.bbox_buffer_km)
    cache_key = hashlib.sha1(",".join(f"{value:.5f}" for value in bbox).encode("utf-8")).hexdigest()[:12]
    return Path("data") / f"route-{cache_key}.graphml"


def load_graph(args: argparse.Namespace) -> nx.MultiDiGraph:
    configure_osmnx()
    cache_path = Path(args.graph_cache) if args.graph_cache else default_cache_path(args)
    if cache_path.exists():
        graph = ox.load_graphml(cache_path)
    elif args.place:
        graph = ox.graph_from_place(args.place, network_type="bike", simplify=True, retain_all=False)
    else:
        bbox = route_bbox(args.origin, args.destination, args.bbox_buffer_km)
        graph = ox.graph_from_bbox(bbox, network_type="bike", simplify=True, retain_all=False, truncate_by_edge=True)

    add_detour_weights(graph)

    if not cache_path.exists():
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        ox.save_graphml(graph, cache_path)

    return graph


def best_edge_data(graph: nx.MultiDiGraph, u: int, v: int, weight: str) -> dict[str, Any]:
    edges = graph.get_edge_data(u, v)
    if not edges:
        raise RuntimeError(f"Route references missing edge {u}->{v}.")
    return min(edges.values(), key=lambda data: float(data.get(weight, data.get("length", 1.0))))


def route_points(graph: nx.MultiDiGraph, route: list[int], weight: str) -> list[list[float]]:
    points: list[list[float]] = []
    for u, v in zip(route[:-1], route[1:]):
        data = best_edge_data(graph, u, v, weight)
        geometry = data.get("geometry")
        if geometry is not None:
            coords = [[float(lon), float(lat)] for lon, lat in geometry.coords]
        else:
            coords = [
                [float(graph.nodes[u]["x"]), float(graph.nodes[u]["y"])],
                [float(graph.nodes[v]["x"]), float(graph.nodes[v]["y"])],
            ]
        if points and coords and points[-1] == coords[0]:
            points.extend(coords[1:])
        else:
            points.extend(coords)
    return points


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_m = 6_371_000
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    return 2 * radius_m * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def nearest_node(graph: nx.MultiDiGraph, point: tuple[float, float]) -> int:
    lat, lon = point
    return min(
        graph.nodes,
        key=lambda node: haversine_m(lat, lon, float(graph.nodes[node]["y"]), float(graph.nodes[node]["x"])),
    )


def summarize_route(graph: nx.MultiDiGraph, route: list[int], weight: str) -> dict[str, Any]:
    total_length = 0.0
    weighted_cost = 0.0
    class_lengths: Counter[str] = Counter()
    names: list[str] = []

    for u, v in zip(route[:-1], route[1:]):
        data = best_edge_data(graph, u, v, weight)
        length = float(data.get("length", 0.0))
        total_length += length
        weighted_cost += float(data.get(weight, length))
        class_lengths[str(data.get("detour_class", "unknown"))] += length
        name = data.get("name")
        if isinstance(name, list):
            name = name[0] if name else None
        if name and name not in names:
            names.append(str(name))

    protected = class_lengths["separated_path"] + class_lengths["protected_lane"]
    comfort_score = round(
        max(
            0,
            min(
                100,
                100
                - 42 * (class_lengths["major_mixed"] + class_lengths["high_speed_arterial"]) / max(total_length, 1)
                - 20 * class_lengths["unknown"] / max(total_length, 1)
                + 15 * protected / max(total_length, 1),
            ),
        )
    )

    return {
        "distance_m": round(total_length),
        "weighted_cost": round(weighted_cost, 1),
        "comfort_score": comfort_score,
        "infrastructure_breakdown": {
            key: round(value / max(total_length, 1), 3) for key, value in sorted(class_lengths.items())
        },
        "sample_streets": names[:8],
    }


def build_feature(
    graph: nx.MultiDiGraph,
    route: list[int],
    route_id: str,
    label: str,
    weight: str,
    note: str = "",
) -> dict[str, Any]:
    summary = summarize_route(graph, route, weight)
    return {
        "type": "Feature",
        "properties": {
            "id": route_id,
            "label": label,
            "optimizer": weight,
            "note": note,
            **ROUTE_STYLES.get(route_id, {}),
            **summary,
        },
        "geometry": {
            "type": "LineString",
            "coordinates": route_points(graph, route, weight),
        },
    }


def marker_feature(point: tuple[float, float], marker_id: str, label: str, color: str) -> dict[str, Any]:
    lat, lon = point
    return {
        "type": "Feature",
        "properties": {
            "id": marker_id,
            "label": label,
            "marker-color": color,
            "marker-size": "medium",
            "marker-symbol": "bicycle" if marker_id == "origin" else "circle",
        },
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    }


def route_between(graph: nx.MultiDiGraph, origin: tuple[float, float], destination: tuple[float, float], weight: str) -> list[int]:
    start = nearest_node(graph, origin)
    end = nearest_node(graph, destination)
    return nx.shortest_path(graph, start, end, weight=weight)


def write_geojson(path: Path, features: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, indent=2),
        encoding="utf-8",
    )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Compare shortest and bike-path-first OSM routes in Montréal.")
    parser.add_argument("--origin", type=parse_lat_lon, default=DEFAULT_ORIGIN, help="Origin as 'lat,lon'.")
    parser.add_argument("--destination", type=parse_lat_lon, default=DEFAULT_DESTINATION, help="Destination as 'lat,lon'.")
    parser.add_argument("--output-dir", default="routes", help="Directory for GeoJSON output.")
    parser.add_argument("--graph-cache", default="", help="Optional GraphML cache path override.")
    parser.add_argument("--bbox-buffer-km", type=float, default=1.5, help="Buffer around the origin/destination bbox.")
    parser.add_argument(
        "--max-detour-ratio",
        type=float,
        default=1.25,
        help="Fallback if bike-path-first is more than this multiple of shortest distance. Use 0 to disable.",
    )
    parser.add_argument(
        "--place",
        default="",
        help="Optional full place query, e.g. 'Montréal, Québec, Canada'. Slower than route bbox.",
    )
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()
    graph = load_graph(args)

    shortest = route_between(graph, args.origin, args.destination, "shortest_cost")
    bike_path_first = route_between(graph, args.origin, args.destination, "bike_path_first_cost")
    shortest_summary = summarize_route(graph, shortest, "shortest_cost")
    comfort_summary = summarize_route(graph, bike_path_first, "bike_path_first_cost")
    comfort_note = ""

    if args.max_detour_ratio and comfort_summary["distance_m"] > shortest_summary["distance_m"] * args.max_detour_ratio:
        comfort_note = (
            f"Rejected original comfort route because it was "
            f"{comfort_summary['distance_m'] / shortest_summary['distance_m']:.2f}x the shortest route; "
            "showing shortest as fallback."
        )
        bike_path_first = shortest
        comfort_summary = shortest_summary

    features = [
        build_feature(graph, shortest, "shortest", "Shortest Route", "shortest_cost"),
        build_feature(graph, bike_path_first, "bike_path_first", "Bike Path First", "bike_path_first_cost", comfort_note),
        marker_feature(args.origin, "origin", "Origin", "#111827"),
        marker_feature(args.destination, "destination", "Destination", "#16a34a"),
    ]

    output_dir = Path(args.output_dir)
    write_geojson(output_dir / "route_comparison.geojson", features)
    write_geojson(output_dir / "shortest.geojson", [features[0]])
    write_geojson(output_dir / "bike_path_first.geojson", [features[1]])

    for feature in features[:2]:
        props = feature["properties"]
        print(
            f"{props['label']}: {props['distance_m']} m, "
            f"comfort {props['comfort_score']}/100, "
            f"breakdown {props['infrastructure_breakdown']}"
        )
        if props.get("note"):
            print(f"  note: {props['note']}")
    print(f"Wrote GeoJSON to {output_dir.resolve()}")


if __name__ == "__main__":
    main()
