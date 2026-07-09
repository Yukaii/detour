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

## Local map preview

After generating a route, start a local server from the project root:

```bash
python3 -m http.server 8000
```

Then open [http://localhost:8000/preview/](http://localhost:8000/preview/). The viewer has an Own bike/BIXI switch, route summaries, and clickable station availability details. Refresh after rerunning the router to see a new live BIXI result.

You can still open the GeoJSON in geojson.io, QGIS, or another map viewer to inspect raw data.

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

## MVP limitations and next backend work

The router is a routing experiment, not yet a production navigation backend. Its comfort model is intentionally a transparent OSM-tag heuristic rather than a machine-learning model: road tags are classified into infrastructure types, and each type receives a routing multiplier.

Current limitations:

- BIXI walking legs use straight-line distance, not a pedestrian routing graph. Walking time can therefore be optimistic, and a selected station may involve an awkward crossing or barrier.
- BIXI station selection evaluates only the locally best pickup and dropoff candidates (`--station-candidate-limit`, default `6`). A slightly farther station with a materially better bike route may be missed.
- Comfort depends on OpenStreetMap tag coverage and does not yet model slope, construction, seasonal closures, traffic volume, road width, intersection stress, or rider-specific preferences.
- BIXI availability is live when the CLI runs, but the generated GeoJSON is a snapshot. It does not refresh itself and currently carries no fetch timestamp.
- There are no automated routing tests or calibrated rider-feedback dataset yet. A `100/100` comfort score means the route best matches the current heuristic; it is not a validated safety or rider-satisfaction claim.

Recommended backend sequence:

1. Route the walking legs on a pedestrian graph and use those distances in BIXI station scoring.
2. Return two or three ranked BIXI station-pair options instead of a single result.
3. Add data timestamps, structured errors, and an API boundary before connecting a real frontend.
4. Build a small set of known Montréal trips, manually review the routes, and tune `CLASS_MULTIPLIERS` against that evidence.

## Notes

- The default graph query uses a route-sized bounding box for faster iteration.
- Pass `--place "Montréal, Québec, Canada"` to fetch a broader Montréal graph, but expect a slower first run.
- OSMnx caching is enabled, and the graph is also saved under `data/` using a cache name derived from the route bounds. Use `--graph-cache path/to/file.graphml` if you want to pin or reuse a specific graph.
- `--max-detour-ratio` prevents the comfort route from becoming an absurd sightseeing route. Set it to `0` to disable that fallback while tuning raw weights.
- BIXI mode uses the public GBFS discovery feed at `https://gbfs.velobixi.com/gbfs/gbfs.json`.
- `--max-walk-minutes` defaults to `8`, because live BIXI availability can make the closest station unusable.
