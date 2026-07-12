import type { BikePreference, Coordinate, PlaceResult, RouteResponse } from "./types";

const API_URL = import.meta.env.VITE_DETOUR_API_URL ?? "https://detour-montreal-api.fly.dev";

// Photon (Komoot) — public OSM geocoder, no API key, browser CORS-friendly.
const PHOTON_URL = "https://photon.komoot.io";
const MONTREAL = { lat: 45.5088, lon: -73.5617 };

// Matches data/graphs/manifest.json prepared pilot coverage.
const COVERAGE = { south: 45.4871, west: -73.6512, north: 45.5571, east: -73.5568 };

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { detail?: string } | null;
  return body?.detail ?? `${fallback} (${response.status})`;
}

function inCoverage(coordinate: Coordinate): boolean {
  const [lon, lat] = coordinate;
  return lat >= COVERAGE.south && lat <= COVERAGE.north && lon >= COVERAGE.west && lon <= COVERAGE.east;
}

interface PhotonProperties {
  osm_id?: number;
  osm_type?: string;
  name?: string;
  street?: string;
  housenumber?: string;
  district?: string;
  locality?: string;
  city?: string;
  state?: string;
  country?: string;
  type?: string;
}

interface PhotonFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: PhotonProperties;
}

interface PhotonResponse {
  type: "FeatureCollection";
  features: PhotonFeature[];
}

function formatPhotonPlace(feature: PhotonFeature): PlaceResult {
  const props = feature.properties;
  const coordinate: Coordinate = [feature.geometry.coordinates[0], feature.geometry.coordinates[1]];
  const streetLine = [props.housenumber, props.street].filter(Boolean).join(" ");
  const name = props.name || streetLine || props.locality || props.city || "Selected place";
  const detail =
    props.district ||
    props.locality ||
    props.city ||
    props.street ||
    props.state ||
    "Montréal";
  return {
    id: `${props.osm_type ?? "n"}-${props.osm_id ?? `${coordinate[1]},${coordinate[0]}`}`,
    name,
    detail,
    coordinate,
    in_coverage: inCoverage(coordinate)
  };
}

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
  if (!response.ok) throw new Error(await readError(response, "Route request failed"));
  return response.json() as Promise<RouteResponse>;
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const params = new URLSearchParams({
    q: term,
    limit: "8",
    lang: "en",
    lat: String(MONTREAL.lat),
    lon: String(MONTREAL.lon),
    // west,south,east,north — bias results to greater Montréal
    bbox: `${COVERAGE.west - 0.08},${COVERAGE.south - 0.05},${COVERAGE.east + 0.08},${COVERAGE.north + 0.05}`
  });

  const response = await fetch(`${PHOTON_URL}/api/?${params}`, { signal });
  if (!response.ok) throw new Error(`Place search failed (${response.status})`);
  const body = (await response.json()) as PhotonResponse;
  const results = (body.features ?? []).map(formatPhotonPlace);

  // Prefer in-coverage places first so the list feels useful for routing.
  return [
    ...results.filter((place) => place.in_coverage),
    ...results.filter((place) => !place.in_coverage)
  ];
}

export async function reverseGeocode(coordinate: Coordinate, signal?: AbortSignal): Promise<PlaceResult> {
  const params = new URLSearchParams({
    lon: String(coordinate[0]),
    lat: String(coordinate[1]),
    lang: "en"
  });
  const response = await fetch(`${PHOTON_URL}/reverse?${params}`, { signal });
  if (!response.ok) {
    return {
      id: `${coordinate[1].toFixed(5)},${coordinate[0].toFixed(5)}`,
      name: "Dropped pin",
      detail: "Selected on map",
      coordinate,
      in_coverage: inCoverage(coordinate)
    };
  }
  const body = (await response.json()) as PhotonResponse;
  const feature = body.features?.[0];
  if (!feature) {
    return {
      id: `${coordinate[1].toFixed(5)},${coordinate[0].toFixed(5)}`,
      name: "Dropped pin",
      detail: "Selected on map",
      coordinate,
      in_coverage: inCoverage(coordinate)
    };
  }
  return formatPhotonPlace(feature);
}
