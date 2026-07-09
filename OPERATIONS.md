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
