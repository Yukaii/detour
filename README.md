# Détour Montréal Bike Router Experiment

Smallest useful prototype for the Détour MVP brief: fetch a Montréal OpenStreetMap bike graph, classify edge comfort from OSM tags, and compare a shortest route against a bike-path-first route.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

Default route: Place des Arts to Parc Martin-Luther-King area.

```bash
python detour_router.py
```

Custom route:

```bash
python detour_router.py \
  --origin "45.50884,-73.58781" \
  --destination "45.53535,-73.62022"
```

Outputs:

- `routes/route_comparison.geojson`
- `routes/shortest.geojson`
- `routes/bike_path_first.geojson`

Open the GeoJSON in geojson.io, QGIS, or any map viewer to visually compare the route shapes.

## Tuning

The first comfort model is intentionally simple and lives in `CLASS_MULTIPLIERS` in `detour_router.py`.

Lower multipliers make infrastructure more attractive:

- `separated_path`
- `protected_lane`
- `painted_bike_lane`
- `quiet_street`

Higher multipliers penalize stressful riding:

- `major_mixed`
- `high_speed_arterial`
- `unknown`

## Notes

- The default graph query uses a route-sized bounding box for faster iteration.
- Pass `--place "Montréal, Québec, Canada"` to fetch a broader Montréal graph, but expect a slower first run.
- OSMnx caching is enabled, and the graph is also saved under `data/` using a cache name derived from the route bounds. Use `--graph-cache path/to/file.graphml` if you want to pin or reuse a specific graph.
