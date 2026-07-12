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

The v1 API accepts endpoints only inside the hard-coded Montréal service bounds. This prevents public requests from downloading arbitrary global OSM graphs and exhausting disk space. Expand the boundary deliberately as service coverage grows.

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

The OSMnx HTTP cache remains ephemeral on Fly.io; the larger parsed GraphML files use the persistent data volume. Keep the machine count at one until cache and rate-limit state move to shared infrastructure.

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
