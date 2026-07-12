#!/usr/bin/env python3
"""Build an immutable routing graph bundle outside the API request path."""

from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime
from pathlib import Path

import osmnx as ox

from detour_router import add_detour_weights, atomic_save_graphml, configure_osmnx


def parse_bounds(value: str) -> tuple[float, float, float, float]:
    try:
        south, west, north, east = (float(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("Use 'south,west,north,east'.") from error
    if south >= north or west >= east:
        raise argparse.ArgumentTypeError("Bounds must satisfy south < north and west < east.")
    return south, west, north, east


def build_graph(bounds: tuple[float, float, float, float], network_type: str):
    south, west, north, east = bounds
    graph = ox.graph_from_bbox(
        (west, south, east, north),
        network_type=network_type,
        simplify=True,
        retain_all=False,
        truncate_by_edge=True,
    )
    if network_type == "bike":
        add_detour_weights(graph)
    else:
        for _, _, _, data in graph.edges(keys=True, data=True):
            data["shortest_cost"] = float(data.get("length", 1.0))
    return graph


def write_manifest(path: Path, payload: dict) -> None:
    temporary_path = path.with_suffix(f"{path.suffix}.tmp")
    temporary_path.write_text(json.dumps(payload, indent=2) + "\n")
    os.replace(temporary_path, path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bounds", required=True, type=parse_bounds, help="Coverage as south,west,north,east.")
    parser.add_argument("--output-dir", type=Path, default=Path("data/graphs"))
    parser.add_argument("--version", default=datetime.now(UTC).strftime("%Y%m%d"))
    args = parser.parse_args()

    configure_osmnx()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}
    stats: dict[str, dict[str, int]] = {}
    for network_type in ("bike", "walk"):
        filename = f"montreal-{args.version}-{network_type}.graphml"
        path = args.output_dir / filename
        graph = build_graph(args.bounds, network_type)
        atomic_save_graphml(graph, path)
        files[network_type] = filename
        stats[network_type] = {"nodes": graph.number_of_nodes(), "edges": graph.number_of_edges()}

    south, west, north, east = args.bounds
    write_manifest(
        args.output_dir / "manifest.json",
        {
            "version": args.version,
            "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "bounds": {"south": south, "west": west, "north": north, "east": east},
            "files": files,
            "stats": stats,
        },
    )


if __name__ == "__main__":
    main()
