import type { BikePreference, Coordinate, RouteResponse } from "./types";

const API_URL = import.meta.env.VITE_DETOUR_API_URL ?? "https://detour-montreal-api.fly.dev";

export async function fetchRoutes(
  origin: Coordinate,
  destination: Coordinate,
  bikePreference: BikePreference,
  signal?: AbortSignal
): Promise<RouteResponse> {
  const params = new URLSearchParams({
    origin: `${origin[1]},${origin[0]}`,
    destination: `${destination[1]},${destination[0]}`,
    bike_preference: bikePreference,
    max_walk_minutes: "15",
    options: "3"
  });
  const response = await fetch(`${API_URL}/v1/routes/bixi?${params}`, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail ?? `Route request failed (${response.status})`);
  }
  return response.json() as Promise<RouteResponse>;
}
