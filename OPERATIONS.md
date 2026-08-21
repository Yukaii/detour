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
| `DETOUR_ROUTING_PROVIDER` | `osm` | Bicycle-leg provider: `osm` or `valhalla`. Docker Compose overrides this to `valhalla`. |
| `DETOUR_VALHALLA_URL` | `http://valhalla:8002` | Base URL of the private Valhalla service. |
| `DETOUR_VALHALLA_TIMEOUT_SECONDS` | `10` | Timeout for Valhalla matrix and route requests. |
| `DETOUR_PRELOAD_GRAPHS` | `true` | Eager-load prepared graphs at API startup. The Vercel image sets this to `false` to bind `$PORT` before its startup deadline. |
| `DETOUR_TRAFFIC_RESTRICTIONS_ENABLED` | `false` | Enable polling of the configured CIFS-compatible restriction feed. Keep disabled until a working Montréal endpoint is verified. |
| `DETOUR_TRAFFIC_RESTRICTIONS_URL` | empty | HTTPS URL for the CIFS-compatible JSON feed. |
| `DETOUR_TRAFFIC_RESTRICTIONS_TTL_SECONDS` | `90` | Per-process lifetime of a restriction snapshot. |
| `DETOUR_TRAFFIC_RESTRICTIONS_STALE_SECONDS` | `300` | Maximum accepted age of a timestamped feed before restrictions fail open. |

The v1 API accepts endpoints only inside the hard-coded Montréal service bounds. This prevents public requests from downloading arbitrary global OSM graphs and exhausting disk space. Expand the boundary deliberately as service coverage grows.

## Valhalla graph lifecycle

The Compose Valhalla service uses the official scripted image and stores tiles in the `valhalla-data` volume. On first startup it downloads the Québec Geofabrik extract and builds its routing graph. The API `/ready` endpoint reports `503` while a configured Valhalla service is unavailable; `/health` remains process liveness only.

Override `DETOUR_VALHALLA_TILE_URLS` with a smaller maintained Montréal extract when one is available. Refreshing the source PBF and restarting the scripted image triggers its hash-based tile rebuild. Validate known routes before promoting refreshed tiles.

In production, run Valhalla as a private service with persistent tile storage and point `DETOUR_VALHALLA_URL` at it. The existing Fly configuration deploys only the API container, so enabling Valhalla there requires provisioning that service separately. The Détour CIFS restriction overlay currently applies only to the legacy OSM route calculation; Valhalla responses disclose that limitation in `traffic_restrictions.detail`.

The repository includes `fly.valhalla.toml` for a private Toronto deployment. It pins the Valhalla image, builds from the current Québec Geofabrik extract, and mounts `valhalla_data` at `/custom_files`. Create a 10 GB volume before the initial deployment. The service runs on a 1 GB shared machine after the tiles have been built; temporarily resize it to 4 GB before any graph rebuild, then validate memory and route latency before returning it to 1 GB. The API reaches it over Fly's private network at `http://detour-montreal-valhalla.internal:8002`.

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

The included `fly.toml` runs one 2 GB machine in Fly.io's nearest available Canadian region, Toronto (`yyz`), mounts a persistent volume at `/app/data`, and scales to zero when idle. The first request after an idle stop must reload the prepared graphs and can take roughly 30-40 seconds. Public requests never build graphs; run graph construction offline and upload the completed bundle before restarting the API.

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

## Vercel container migration proof of concept

The migration branch keeps the Fly deployment as the rollback target and defines two Vercel container services in `vercel.json`:

- `api` is the only public service. It embeds the versioned compressed bike and walk graphs, expands them while building the image, and listens on Vercel's `$PORT`.
- `valhalla` is internal. A service binding injects its private URL into the API as `DETOUR_VALHALLA_URL`.
- both services are stateless and scale to zero. No Vercel runtime writes depend on persistent storage.

The Valhalla serving bundle is about 241 MB compressed. It contains `valhalla_tiles.tar`, `admins.sqlite`, `timezones.sqlite`, `default_speeds.json`, and `valhalla.json`; it deliberately omits the 1.16 GB Québec source PBF and the duplicate unpacked tile directory. Export it reproducibly from the running Fly volume:

```bash
./scripts/export-valhalla-vercel-bundle.sh
```

The generated `.vercel-artifacts` directory is ignored by Git and Vercel. Vercel Hobby accepts at most 100 MB of CLI source files, so the Valhalla Docker build downloads the checksum-pinned bundle from a GitHub release instead. Publishing that public artifact is a separate, one-time GitHub write:

```bash
./scripts/publish-valhalla-vercel-bundle.sh
```

Do not run the publish command until the release asset is approved. If the graph is refreshed, create a new immutable release tag, update `vercel/valhalla/valhalla-runtime.env` with its URL and SHA-256, and retain the previous release for rollback.

Before the first preview deployment:

1. Log in with `npx vercel login`, create or link the project, and set its Framework Preset to **Services**. The `services` block is ignored unless the project has that preset.
2. Select Montréal (`yul1`) as the function region.
3. Set `DETOUR_CORS_ORIGINS` to the frontend origins, currently `https://detour.yukai.dev,https://yukaii.github.io` for the custom domain and GitHub Pages domain.
4. Set `DETOUR_VALHALLA_TIMEOUT_SECONDS=30` for the initial cold-start trial. New projects created after June 30, 2026 receive large Functions automatically; otherwise set `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`.
5. Verify that the API receives 2 GB memory and Valhalla receives at least 1 GB. Keep both at one effective instance until process-local rate-limit and cache state move to shared infrastructure.

Deploy a preview before changing the frontend:

```bash
npx vercel deploy
```

Probe `/health`, `/ready`, and a representative `/v1/routes/bixi` request before pointing `VITE_DETOUR_API_URL` at the Vercel production URL. Keep both Fly apps and their volumes intact during the initial production observation period; rollback is only a frontend endpoint change. Measure cold-start latency, warm latency, provisioned-memory hours, active CPU, and origin transfer before retiring Fly.

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
