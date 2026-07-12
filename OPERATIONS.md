# Operations

## Local container run

```bash
docker compose up --build
```

The API listens on `http://localhost:8001`. Docker volumes persist the downloaded OSM graph and OSMnx HTTP cache, so the first route for an area can be slower than later requests.

## Runtime configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DETOUR_CORS_ORIGINS` | local preview origins | Comma-separated browser origins allowed to call the API. |
| `DETOUR_ROUTE_CACHE_TTL_SECONDS` | `60` | Per-process cache lifetime for identical BIXI route requests. |
| `DETOUR_RATE_LIMIT_PER_MINUTE` | `30` | Per-client request ceiling in the single API process. |
| `DETOUR_MAX_ROUTE_DISTANCE_KM` | `35` | Maximum straight-line distance between route endpoints. |
| `DETOUR_GRAPH_MANIFEST_PATH` | `data/graphs/manifest.json` | Versioned prepared-graph bundle loaded by the API. |
| `DETOUR_TRAFFIC_RESTRICTIONS_ENABLED` | `false` | Enable polling of the configured CIFS-compatible restriction feed. Keep disabled until a working Montréal endpoint is verified. |
| `DETOUR_TRAFFIC_RESTRICTIONS_URL` | empty | HTTPS URL for the CIFS-compatible JSON feed. |
| `DETOUR_TRAFFIC_RESTRICTIONS_TTL_SECONDS` | `90` | Per-process lifetime of a restriction snapshot. |
| `DETOUR_TRAFFIC_RESTRICTIONS_STALE_SECONDS` | `300` | Maximum accepted age of a timestamped feed before restrictions fail open. |

The v1 API accepts endpoints only inside the hard-coded Montréal service bounds. This prevents public requests from downloading arbitrary global OSM graphs and exhausting disk space. Expand the boundary deliberately as service coverage grows.

## Live traffic restriction overlay

Phase 1 support is implemented but disabled by default because Montréal's published CIFS endpoint currently returns `404`. When enabled with a verified replacement URL, the API polls and caches the feed separately from route responses, filters events by their active time window, spatially matches event polylines to OSM edges, and applies routing penalties without mutating the prepared graph.

Confirmed full closures exclude matched edges. Bicycle/lane obstructions receive a large penalty, and ambiguous obstructions receive a smaller caution penalty. Stale, malformed, or unavailable feeds fail open: routes remain available and the `traffic_restrictions` response object reports the snapshot status, timestamps, counts, version, and any restriction IDs on the selected options. The snapshot version is part of the route-cache key so a refreshed feed cannot reuse a route from an older restriction state.

Before enabling Phase 2 in production:

- verify the replacement feed URL and capture representative payload fixtures;
- manually review edge matching around divided roads, intersections, and parallel cycle tracks;
- calibrate severity mapping against the feed's actual type/subtype vocabulary;
- add the daily construction-permit dataset only as a lower-confidence supplemental source;
- add upstream freshness and failure metrics.

## Routing graph lifecycle

Public API requests never contact Overpass or construct graphs. Build bike and walking artifacts on a machine with enough memory:

```bash
.venv/bin/python prepare_graphs.py \
  --bounds "45.48712829,-73.65120866,45.55706171,-73.55682134" \
  --output-dir data/graphs \
  --version "$(date -u +%Y%m%d)"
```

The builder writes each GraphML file atomically and publishes `manifest.json` only after both graphs succeed. The manifest declares coverage, version, generation time, filenames, and graph statistics. The API rejects coordinates outside that coverage and `/ready` returns `503` when the manifest or either graph is missing or empty.

The API loads both graphs during process startup, and Fly checks `/ready` before sending traffic. On the initial 2 GB Fly machine this warm-up can take roughly 15-30 seconds; subsequent uncached route requests in the pilot area have been measured around 1-2 seconds. `/health` remains a liveness probe and does not imply that graph loading has completed.

For Fly.io, upload new versioned graph files to `/app/data/graphs` first and replace `manifest.json` last. Restart the machine to clear the in-memory graph and response caches. Keep the previous version until the new bundle has passed a live route probe; rollback consists of restoring its manifest and restarting.

The initial public bundle covers a central-Montréal pilot area, not the full BIXI network. Expand coverage only after measuring artifact build time, loaded memory, and route latency on the larger bounds.

## Fly.io deployment

The included `fly.toml` runs one always-on 2 GB machine in Fly.io's nearest available Canadian region, Toronto (`yyz`), and mounts a persistent volume at `/app/data`. The 2 GB memory floor is required for OSMnx pedestrian-graph construction. Scale-to-zero is disabled because it can interrupt long graph builds and discards the in-memory graph cache. The first route for uncached bounds may still be slow while OSM data is downloaded.

```bash
fly auth login
fly apps create <unique-app-name>
fly volumes create detour_data --region yyz --size 3 -a <unique-app-name>
fly deploy -a <unique-app-name>
fly checks list -a <unique-app-name>
```

Set the production client origin before connecting a web frontend:

```bash
fly secrets set DETOUR_CORS_ORIGINS=https://your-client.example -a <unique-app-name>
```

The OSMnx HTTP cache is used only by the offline builder. Prepared GraphML files use the persistent data volume. Keep the machine count at one until cache and rate-limit state move to shared infrastructure.

## Deployment boundary

The supplied container deliberately runs one Uvicorn worker. The graph cache, response cache, and rate limiter are all process-local. Before running multiple replicas, replace the local response/rate-limit state with a shared cache such as Redis, prewarm and share the OSM graph storage, and place the service behind an HTTPS reverse proxy or managed gateway.

`/health` confirms that the process is alive. `/ready` confirms that the API process can receive traffic; it does not contact OSM or BIXI, so upstream availability remains visible through route request errors and logs.

## Required production work

- Add centralized logs, metrics, alerting, and uptime checks.
- Set a gateway-level rate limit and trusted-proxy policy; do not trust client-provided forwarding headers by default.
- Schedule graph refreshes and validate refreshed data before promotion.
- Retain route request telemetry only with a documented privacy policy and data-retention limit.
- Calibrate the comfort model with reviewed Montréal routes and rider feedback.
- Validate maneuver generation against representative Montréal intersections before enabling voice guidance or automatic rerouting.
