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

BIXI route with live station availability:

```bash
python detour_router.py --mode bixi
```

Prefer e-bikes or regular bikes:

```bash
python detour_router.py --mode bixi --bike-preference ebike
python detour_router.py --mode bixi --bike-preference regular --max-walk-minutes 10
```

Custom route:

```bash
python detour_router.py \
  --origin "45.50884,-73.58781" \
  --destination "45.53535,-73.62022"
```

Allow a more aggressive comfort detour:

```bash
python detour_router.py --max-detour-ratio 1.5
```

Outputs:

- `routes/route_comparison.geojson`
- `routes/shortest.geojson`
- `routes/bike_path_first.geojson`
- `routes/bixi_route.geojson` when using `--mode bixi`

Open the GeoJSON in geojson.io, QGIS, or any map viewer to visually compare the route shapes.

In geojson.io, the combined comparison file includes:

- red line: shortest route
- blue line: bike-path-first route
- black marker: origin
- green marker: destination

The BIXI route file includes:

- black dashed line: walk to pickup/dropoff
- blue line: BIXI bike leg
- blue marker: pickup station with live bike/e-bike counts
- green marker: dropoff station with live dock count

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
- `--max-detour-ratio` prevents the comfort route from becoming an absurd sightseeing route. Set it to `0` to disable that fallback while tuning raw weights.
- BIXI mode uses the public GBFS discovery feed at `https://gbfs.velobixi.com/gbfs/gbfs.json`.
- `--max-walk-minutes` defaults to `8`, because live BIXI availability can make the closest station unusable.
