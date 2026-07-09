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
import urllib.request
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
DEFAULT_BIXI_GBFS_URL = "https://gbfs.velobixi.com/gbfs/gbfs.json"
WALKING_SPEED_M_PER_MIN = 80

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
    "bixi_bike": {"stroke": "#2563eb", "stroke-width": 6, "stroke-opacity": 0.9},
    "walk_to_pickup": {"stroke": "#111827", "stroke-width": 3, "stroke-opacity": 0.7, "stroke-dasharray": "4,4"},
    "walk_to_destination": {"stroke": "#111827", "stroke-width": 3, "stroke-opacity": 0.7, "stroke-dasharray": "4,4"},
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


def straight_line_points(start: tuple[float, float], end: tuple[float, float]) -> list[list[float]]:
    return [[start[1], start[0]], [end[1], end[0]]]


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


def fetch_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"User-Agent": "detour-router/0.1"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def gbfs_feed_urls(discovery_url: str, language: str) -> dict[str, str]:
    discovery = fetch_json(discovery_url)
    data = discovery.get("data", {})
    feeds = data.get(language) or data.get("en") or next(iter(data.values()))
    return {feed["name"]: feed["url"] for feed in feeds.get("feeds", [])}


def load_bixi_stations(discovery_url: str, language: str) -> list[dict[str, Any]]:
    urls = gbfs_feed_urls(discovery_url, language)
    missing = {"station_information", "station_status"} - set(urls)
    if missing:
        raise RuntimeError(f"BIXI GBFS feed is missing required files: {', '.join(sorted(missing))}")

    info_data = fetch_json(urls["station_information"])
    status_data = fetch_json(urls["station_status"])
    status_by_id = {station["station_id"]: station for station in status_data["data"]["stations"]}

    stations: list[dict[str, Any]] = []
    for info in info_data["data"]["stations"]:
        status = status_by_id.get(info["station_id"])
        if not status:
            continue
        station = {**info, **status}
        station["point"] = (float(station["lat"]), float(station["lon"]))
        station["available_regular_bikes"] = max(
            0,
            int(station.get("num_bikes_available", 0)) - int(station.get("num_ebikes_available", 0)),
        )
        stations.append(station)
    return stations


def active_for_pickup(station: dict[str, Any], bike_preference: str) -> bool:
    if not station.get("is_installed") or not station.get("is_renting"):
        return False
    if bike_preference == "ebike":
        return int(station.get("num_ebikes_available", 0)) > 0
    if bike_preference == "regular":
        return int(station.get("available_regular_bikes", 0)) > 0
    return int(station.get("num_bikes_available", 0)) > 0


def active_for_dropoff(station: dict[str, Any]) -> bool:
    return bool(station.get("is_installed") and station.get("is_returning") and int(station.get("num_docks_available", 0)) > 0)


def station_availability_penalty(station: dict[str, Any], kind: str, bike_preference: str) -> float:
    if kind == "pickup":
        if bike_preference == "ebike":
            available = int(station.get("num_ebikes_available", 0))
        elif bike_preference == "regular":
            available = int(station.get("available_regular_bikes", 0))
        else:
            available = int(station.get("num_bikes_available", 0))
    else:
        available = int(station.get("num_docks_available", 0))

    if available <= 1:
        return 500
    if available <= 3:
        return 220
    if available <= 6:
        return 80
    return 0


def station_candidates(
    stations: list[dict[str, Any]],
    point: tuple[float, float],
    max_walk_m: float,
    kind: str,
    bike_preference: str,
    limit: int,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for station in stations:
        if kind == "pickup" and not active_for_pickup(station, bike_preference):
            continue
        if kind == "dropoff" and not active_for_dropoff(station):
            continue
        distance_m = haversine_m(point[0], point[1], station["point"][0], station["point"][1])
        if distance_m > max_walk_m:
            continue
        candidate = dict(station)
        candidate["walk_distance_m"] = round(distance_m)
        candidate["station_score"] = distance_m + station_availability_penalty(station, kind, bike_preference)
        candidates.append(candidate)
    return sorted(candidates, key=lambda station: station["station_score"])[:limit]


def nearest_station_snapshot(
    stations: list[dict[str, Any]],
    point: tuple[float, float],
    kind: str,
    bike_preference: str,
    limit: int = 5,
) -> str:
    rows = []
    for station in stations:
        distance_m = round(haversine_m(point[0], point[1], station["point"][0], station["point"][1]))
        if kind == "pickup":
            availability = f"{station.get('num_bikes_available', 0)} bikes, {station.get('num_ebikes_available', 0)} e-bikes"
            usable = active_for_pickup(station, bike_preference)
        else:
            availability = f"{station.get('num_docks_available', 0)} docks"
            usable = active_for_dropoff(station)
        rows.append((distance_m, station["name"], availability, usable))
    return "; ".join(
        f"{name} ({distance_m} m, {availability}, {'usable' if usable else 'not usable'})"
        for distance_m, name, availability, usable in sorted(rows)[:limit]
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


def station_marker_feature(station: dict[str, Any], marker_id: str, label: str, color: str) -> dict[str, Any]:
    return {
        "type": "Feature",
        "properties": {
            "id": marker_id,
            "label": label,
            "station_id": station["station_id"],
            "station_name": station["name"],
            "available_bikes": int(station.get("num_bikes_available", 0)),
            "available_regular_bikes": int(station.get("available_regular_bikes", 0)),
            "available_ebikes": int(station.get("num_ebikes_available", 0)),
            "available_docks": int(station.get("num_docks_available", 0)),
            "walk_distance_m": station.get("walk_distance_m"),
            "marker-color": color,
            "marker-size": "large",
            "marker-symbol": "bicycle",
        },
        "geometry": {"type": "Point", "coordinates": [station["point"][1], station["point"][0]]},
    }


def line_feature(
    points: list[list[float]],
    route_id: str,
    label: str,
    properties: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "type": "Feature",
        "properties": {
            "id": route_id,
            "label": label,
            **ROUTE_STYLES.get(route_id, {}),
            **(properties or {}),
        },
        "geometry": {"type": "LineString", "coordinates": points},
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


def run_own_bike(args: argparse.Namespace, graph: nx.MultiDiGraph) -> None:
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


def best_bixi_route(args: argparse.Namespace, graph: nx.MultiDiGraph) -> dict[str, Any]:
    stations = load_bixi_stations(args.bixi_gbfs_url, args.gbfs_language)
    max_walk_m = args.max_walk_minutes * WALKING_SPEED_M_PER_MIN
    pickups = station_candidates(stations, args.origin, max_walk_m, "pickup", args.bike_preference, args.station_candidate_limit)
    dropoffs = station_candidates(stations, args.destination, max_walk_m, "dropoff", args.bike_preference, args.station_candidate_limit)

    if not pickups:
        nearby = nearest_station_snapshot(stations, args.origin, "pickup", args.bike_preference)
        raise RuntimeError(
            f"No usable BIXI pickup stations within {args.max_walk_minutes} minutes of origin. "
            f"Nearest stations: {nearby}"
        )
    if not dropoffs:
        nearby = nearest_station_snapshot(stations, args.destination, "dropoff", args.bike_preference)
        raise RuntimeError(
            f"No usable BIXI dropoff stations within {args.max_walk_minutes} minutes of destination. "
            f"Nearest stations: {nearby}"
        )

    best: dict[str, Any] | None = None
    for pickup in pickups:
        for dropoff in dropoffs:
            try:
                route = route_between(graph, pickup["point"], dropoff["point"], "bike_path_first_cost")
            except nx.NetworkXNoPath:
                continue
            summary = summarize_route(graph, route, "bike_path_first_cost")
            total_score = pickup["station_score"] + dropoff["station_score"] + float(summary["weighted_cost"])
            total_walk_m = pickup["walk_distance_m"] + dropoff["walk_distance_m"]
            result = {
                "pickup": pickup,
                "dropoff": dropoff,
                "route": route,
                "summary": summary,
                "total_score": total_score,
                "total_walk_m": total_walk_m,
            }
            if best is None or result["total_score"] < best["total_score"]:
                best = result

    if best is None:
        raise RuntimeError("Could not route between any BIXI pickup/dropoff candidate pair.")
    return best


def run_bixi(args: argparse.Namespace, graph: nx.MultiDiGraph) -> None:
    result = best_bixi_route(args, graph)
    pickup = result["pickup"]
    dropoff = result["dropoff"]
    bike_summary = result["summary"]

    walk_to_pickup_m = pickup["walk_distance_m"]
    walk_to_destination_m = dropoff["walk_distance_m"]
    total_minutes = round(
        walk_to_pickup_m / WALKING_SPEED_M_PER_MIN
        + bike_summary["distance_m"] / 250
        + walk_to_destination_m / WALKING_SPEED_M_PER_MIN
    )

    bike_props = {
        "pickup_station": pickup["name"],
        "dropoff_station": dropoff["name"],
        "walk_to_pickup_m": walk_to_pickup_m,
        "walk_to_destination_m": walk_to_destination_m,
        "total_walk_m": result["total_walk_m"],
        "estimated_total_minutes": total_minutes,
        **bike_summary,
    }
    features = [
        line_feature(
            straight_line_points(args.origin, pickup["point"]),
            "walk_to_pickup",
            "Walk to BIXI pickup",
            {"distance_m": walk_to_pickup_m},
        ),
        line_feature(
            route_points(graph, result["route"], "bike_path_first_cost"),
            "bixi_bike",
            "BIXI bike leg",
            bike_props,
        ),
        line_feature(
            straight_line_points(dropoff["point"], args.destination),
            "walk_to_destination",
            "Walk to destination",
            {"distance_m": walk_to_destination_m},
        ),
        marker_feature(args.origin, "origin", "Origin", "#111827"),
        station_marker_feature(pickup, "bixi_pickup", f"Pickup: {pickup['name']}", "#2563eb"),
        station_marker_feature(dropoff, "bixi_dropoff", f"Dropoff: {dropoff['name']}", "#16a34a"),
        marker_feature(args.destination, "destination", "Destination", "#16a34a"),
    ]

    output_dir = Path(args.output_dir)
    write_geojson(output_dir / "bixi_route.geojson", features)
    print(f"BIXI route: {total_minutes} min estimated total")
    print(
        f"Pickup: {pickup['name']} - {pickup['walk_distance_m']} m walk, "
        f"{pickup.get('num_bikes_available', 0)} total bikes, "
        f"{pickup.get('available_regular_bikes', 0)} regular, "
        f"{pickup.get('num_ebikes_available', 0)} e-bikes"
    )
    print(
        f"Dropoff: {dropoff['name']} - {dropoff['walk_distance_m']} m walk, "
        f"{dropoff.get('num_docks_available', 0)} docks"
    )
    print(
        f"Bike leg: {bike_summary['distance_m']} m, comfort {bike_summary['comfort_score']}/100, "
        f"breakdown {bike_summary['infrastructure_breakdown']}"
    )
    print(f"Wrote GeoJSON to {(output_dir / 'bixi_route.geojson').resolve()}")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Compare shortest and bike-path-first OSM routes in Montréal.")
    parser.add_argument("--mode", choices=["own-bike", "bixi"], default="own-bike", help="Route mode.")
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
    parser.add_argument(
        "--bike-preference",
        choices=["any", "ebike", "regular"],
        default="any",
        help="BIXI bike availability filter.",
    )
    parser.add_argument("--max-walk-minutes", type=float, default=8, help="Max walk time to BIXI stations.")
    parser.add_argument("--station-candidate-limit", type=int, default=6, help="BIXI candidates to evaluate per endpoint.")
    parser.add_argument("--bixi-gbfs-url", default=DEFAULT_BIXI_GBFS_URL, help="BIXI GBFS discovery URL.")
    parser.add_argument("--gbfs-language", default="en", help="GBFS language key to read from discovery feed.")
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()
    graph = load_graph(args)
    if args.mode == "bixi":
        run_bixi(args, graph)
    else:
        run_own_bike(args, graph)


if __name__ == "__main__":
    main()
