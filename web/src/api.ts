import type { BikePreference, BixiStationsResponse, Coordinate, PlaceResult, RouteResponse } from "./types";

const API_URL = import.meta.env.VITE_DETOUR_API_URL
  ?? (import.meta.env.DEV ? "http://127.0.0.1:8001" : "https://detour-montreal.vercel.app");

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { detail?: string } | null;
  return body?.detail ?? `${fallback} (${response.status})`;
}

export async function fetchRoutes(
  origin: Coordinate,
  destination: Coordinate,
  bikePreference: BikePreference,
  signal?: AbortSignal,
  stationChoice?: { kind: "pickup" | "dropoff"; stationId: string }
): Promise<RouteResponse> {
  const params = new URLSearchParams({
    origin: `${origin[1]},${origin[0]}`,
    destination: `${destination[1]},${destination[0]}`,
    bike_preference: bikePreference,
    max_walk_minutes: "15",
    options: "3"
  });
  if (stationChoice) params.set(`${stationChoice.kind}_station_id`, stationChoice.stationId);
  const response = await fetch(`${API_URL}/v1/routes/bixi?${params}`, { signal });
  if (!response.ok) throw new Error(await readError(response, "Route request failed"));
  return response.json() as Promise<RouteResponse>;
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const params = new URLSearchParams({ q: term, limit: "8" });
  const response = await fetch(`${API_URL}/v1/places/search?${params}`, { signal });
  if (!response.ok) throw new Error(await readError(response, "Place search failed"));
  const body = (await response.json()) as { results?: PlaceResult[] };
  return body.results ?? [];
}

export async function reverseGeocode(coordinate: Coordinate, signal?: AbortSignal): Promise<PlaceResult> {
  const params = new URLSearchParams({
    lon: String(coordinate[0]),
    lat: String(coordinate[1])
  });
  const response = await fetch(`${API_URL}/v1/places/reverse?${params}`, { signal });
  if (!response.ok) {
    return {
      id: `${coordinate[1].toFixed(5)},${coordinate[0].toFixed(5)}`,
      name: "Dropped pin",
      detail: "Selected on map",
      coordinate,
      in_coverage: false
    };
  }
  return response.json() as Promise<PlaceResult>;
}

export async function fetchBixiStations(signal?: AbortSignal): Promise<BixiStationsResponse> {
  const response = await fetch(`${API_URL}/v1/stations/bixi`, { signal });
  if (!response.ok) throw new Error(await readError(response, "Station request failed"));
  return response.json() as Promise<BixiStationsResponse>;
}
