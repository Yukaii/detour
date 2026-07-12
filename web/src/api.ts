import type { BikePreference, Coordinate, PlaceResult, RouteResponse } from "./types";

const API_URL = import.meta.env.VITE_DETOUR_API_URL ?? "https://detour-montreal-api.fly.dev";

// Montréal-ish bounding box for local search (west, south, east, north).
const MONTREAL_VIEWBOX = "-73.98,45.40,-73.40,45.72";
const NOMINATIM_HEADERS = { Accept: "application/json", "Accept-Language": "en" };

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

interface NominatimItem {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  type?: string;
  class?: string;
  address?: {
    road?: string;
    neighbourhood?: string;
    suburb?: string;
    city_district?: string;
    city?: string;
    town?: string;
    village?: string;
    borough?: string;
    quarter?: string;
  };
}

function formatPlace(item: NominatimItem): PlaceResult {
  const parts = item.display_name.split(",").map((part) => part.trim());
  const name = item.name || parts[0] || "Selected place";
  const detail =
    item.address?.neighbourhood ||
    item.address?.suburb ||
    item.address?.borough ||
    item.address?.quarter ||
    item.address?.city_district ||
    item.address?.road ||
    parts.slice(1, 3).join(", ") ||
    "Montréal";
  return {
    id: String(item.place_id),
    name,
    detail,
    coordinate: [Number(item.lon), Number(item.lat)]
  };
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const params = new URLSearchParams({
    q: term,
    format: "json",
    addressdetails: "1",
    limit: "8",
    countrycodes: "ca",
    viewbox: MONTREAL_VIEWBOX,
    bounded: "1"
  });

  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: NOMINATIM_HEADERS,
    signal
  });
  if (!response.ok) throw new Error("Place search failed");
  const data = (await response.json()) as NominatimItem[];
  return data.map(formatPlace);
}

export async function reverseGeocode(coordinate: Coordinate, signal?: AbortSignal): Promise<string> {
  const params = new URLSearchParams({
    lon: String(coordinate[0]),
    lat: String(coordinate[1]),
    format: "json",
    zoom: "17",
    addressdetails: "1"
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
    headers: NOMINATIM_HEADERS,
    signal
  });
  if (!response.ok) return "Dropped pin";
  const data = (await response.json()) as NominatimItem;
  if (!data?.display_name) return "Dropped pin";
  return formatPlace(data).name;
}
