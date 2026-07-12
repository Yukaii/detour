import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";
import maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import {
  Bike,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CircleParking,
  Crosshair,
  Loader2,
  LocateFixed,
  MapPin,
  Navigation,
  RefreshCw,
  Route,
  Search,
  ArrowUpDown,
  Undo2,
  Zap,
  X
} from "lucide-react";
import { fetchBixiStations, fetchRoutes, reverseGeocode, searchPlaces } from "./api";
import type { BikePreference, BixiStation, Coordinate, NearbyStation, PlaceResult, RouteLeg, RouteOption, RouteResponse, RouteStep } from "./types";

const MAP_CENTER: Coordinate = [-73.604, 45.522];
const MAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const DESKTOP_BREAKPOINT = 800;
const SIDEBAR_WIDTH = 390;

// Matches data/graphs/manifest.json prepared pilot coverage.
const COVERAGE = { south: 45.4871, west: -73.6512, north: 45.5571, east: -73.5568 };

const SUGGESTED_PLACES: PlaceResult[] = [
  { id: "jean-talon", name: "Jean-Talon Market", detail: "Little Italy", coordinate: [-73.6148, 45.5361], in_coverage: true },
  { id: "la-fontaine", name: "Parc La Fontaine", detail: "Le Plateau-Mont-Royal", coordinate: [-73.56897, 45.52626], in_coverage: true },
  { id: "mile-end", name: "Mile End", detail: "St-Viateur / Clark", coordinate: [-73.6012, 45.5232], in_coverage: true },
  { id: "jarry", name: "Parc Jarry", detail: "Saint-Laurent entrance", coordinate: [-73.625, 45.5325], in_coverage: true },
  { id: "outremont", name: "Outremont", detail: "Laurier / Bloomfield", coordinate: [-73.6095, 45.5185], in_coverage: true },
  { id: "mcgill", name: "McGill University", detail: "Downtown campus", coordinate: [-73.5772, 45.5048], in_coverage: true }
];

function inCoverage(place: Pick<PlaceResult, "coordinate" | "in_coverage"> | Coordinate): boolean {
  if (Array.isArray(place)) {
    const [lon, lat] = place;
    return lat >= COVERAGE.south && lat <= COVERAGE.north && lon >= COVERAGE.west && lon <= COVERAGE.east;
  }
  if (typeof place.in_coverage === "boolean") return place.in_coverage;
  return inCoverage(place.coordinate);
}

function pointFeature(coordinate: Coordinate, kind: string): FeatureCollection {
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: { kind }, geometry: { type: "Point", coordinates: coordinate } }] };
}

function lineFeature(coordinates: Coordinate[]): FeatureCollection {
  const validCoordinates = coordinates.length === 1 ? [coordinates[0], coordinates[0]] : coordinates;
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: validCoordinates } }] };
}

function stationFeatures(routes: RouteResponse | null, selectedIndex: number, preference: BikePreference): FeatureCollection {
  if (!routes) return { type: "FeatureCollection", features: [] };
  const seen = new Set<string>();
  const selected = routes.options[selectedIndex];
  const legacyCandidates: NearbyStation[] = routes.options.flatMap((option) => [
    { ...option.pickup, available_docks: 0, kind: "pickup" as const },
    {
      ...option.dropoff,
      available_bikes: 0,
      available_regular_bikes: 0,
      available_ebikes: 0,
      kind: "dropoff" as const
    }
  ]);
  const candidates = routes.nearby_stations?.length ? routes.nearby_stations : legacyCandidates;
  return {
    type: "FeatureCollection",
    features: candidates.flatMap((station) => {
      const key = station.station_id;
      if (seen.has(key)) return [];
      seen.add(key);
      const isSelected = station.kind === "pickup" ? selected?.pickup.station_id === station.station_id : selected?.dropoff.station_id === station.station_id;
      return [{
        type: "Feature" as const,
        properties: {
          kind: station.kind,
          stationId: station.station_id,
          selected: isSelected ? 1 : 0,
          count: station.kind === "dropoff" ? station.available_docks : preference === "ebike" ? station.available_ebikes : preference === "regular" ? station.available_regular_bikes : station.available_bikes,
          availabilityLabel: station.kind === "dropoff" ? "DOCKS" : preference === "ebike" ? "E-BIKES" : preference === "regular" ? "REGULAR" : "BIKES",
          name: station.name
        },
        geometry: { type: "Point" as const, coordinates: station.coordinates }
      }];
    })
  };
}

function explorerStationFeatures(stations: BixiStation[], preference: BikePreference, filter: "all" | "bikes" | "docks", selectedId: string | null): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: stations.filter((station) => {
      if (filter === "bikes") return preference === "ebike" ? station.available_ebikes > 0 : preference === "regular" ? station.available_regular_bikes > 0 : station.available_bikes > 0;
      return filter !== "docks" || station.available_docks > 0;
    }).map((station) => ({
      type: "Feature" as const,
      properties: {
        kind: "pickup",
        stationId: station.station_id,
        selected: station.station_id === selectedId ? 1 : 0,
        count: filter === "docks" ? station.available_docks : preference === "ebike" ? station.available_ebikes : preference === "regular" ? station.available_regular_bikes : station.available_bikes,
        availabilityLabel: filter === "docks" ? "DOCKS" : preference === "ebike" ? "E-BIKES" : preference === "regular" ? "REGULAR" : "BIKES"
      },
      geometry: { type: "Point" as const, coordinates: station.coordinates }
    }))
  };
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function timeAgo(timestamp?: string): string {
  if (!timestamp) return "Live status";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000));
  return minutes < 1 ? "Updated now" : `Updated ${minutes}m ago`;
}

function allCoordinates(option: RouteOption): Coordinate[] {
  return [
    ...option.legs.walk_to_pickup.coordinates,
    ...option.legs.bike.coordinates,
    ...option.legs.walk_to_destination.coordinates
  ];
}

type NavigationStep = { step: RouteStep; leg: RouteLeg; mode: "walk" | "bike"; segment: Coordinate[] };

function distanceSquared(a: Coordinate, b: Coordinate): number {
  const latitudeScale = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return ((a[0] - b[0]) * latitudeScale) ** 2 + (a[1] - b[1]) ** 2;
}

function nearestCoordinateIndex(coordinates: Coordinate[], point: Coordinate): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  coordinates.forEach((coordinate, index) => {
    const distance = distanceSquared(coordinate, point);
    if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
  });
  return bestIndex;
}

function routeSteps(option: RouteOption): NavigationStep[] {
  const legs: Array<{ leg: RouteLeg; mode: "walk" | "bike" }> = [
    { leg: option.legs.walk_to_pickup, mode: "walk" },
    { leg: option.legs.bike, mode: "bike" },
    { leg: option.legs.walk_to_destination, mode: "walk" }
  ];
  return legs.flatMap(({ leg, mode }) => leg.steps.map((step, index) => {
    const start = nearestCoordinateIndex(leg.coordinates, step.coordinate);
    const nextStep = leg.steps[index + 1];
    const end = nextStep ? nearestCoordinateIndex(leg.coordinates, nextStep.coordinate) : leg.coordinates.length - 1;
    return { step, leg, mode, segment: leg.coordinates.slice(Math.min(start, end), Math.max(start, end) + 1) };
  }));
}

function routeBearing(coordinates: Coordinate[], index: number): number {
  const from = coordinates[index];
  const to = coordinates[Math.min(index + 4, coordinates.length - 1)];
  if (!from || !to || from === to) return 0;
  const lonDelta = (to[0] - from[0]) * Math.PI / 180;
  const lat1 = from[1] * Math.PI / 180;
  const lat2 = to[1] * Math.PI / 180;
  const y = Math.sin(lonDelta) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lonDelta);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function mapFitPadding(): maplibregl.PaddingOptions {
  if (typeof window !== "undefined" && window.innerWidth >= DESKTOP_BREAKPOINT) {
    return { top: 48, right: 48, bottom: 48, left: SIDEBAR_WIDTH + 48 };
  }
  return { top: 150, right: 50, bottom: 310, left: 50 };
}

function addRouteLayers(map: MapLibreMap): void {
  map.addSource("walk-pickup", { type: "geojson", data: lineFeature([]) });
  map.addSource("bike-route", { type: "geojson", data: lineFeature([]) });
  map.addSource("walk-dropoff", { type: "geojson", data: lineFeature([]) });
  map.addSource("route-points", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("candidate-stations", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterRadius: 42, clusterMaxZoom: 15 });
  map.addSource("user-location", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("navigation-completed", { type: "geojson", data: lineFeature([]) });
  map.addSource("navigation-remaining", { type: "geojson", data: lineFeature([]) });
  map.addSource("step-preview", { type: "geojson", data: lineFeature([]) });
  map.addLayer({
    id: "walk-pickup",
    type: "line",
    source: "walk-pickup",
    paint: { "line-color": "#20262d", "line-width": 3, "line-opacity": 0.72, "line-dasharray": [1, 1.6] },
    layout: { "line-cap": "round", "line-join": "round" }
  });
  map.addLayer({
    id: "bike-route-casing",
    type: "line",
    source: "bike-route",
    paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.92 },
    layout: { "line-cap": "round", "line-join": "round" }
  });
  map.addLayer({
    id: "bike-route",
    type: "line",
    source: "bike-route",
    paint: { "line-color": "#165df5", "line-width": 6 },
    layout: { "line-cap": "round", "line-join": "round" }
  });
  map.addLayer({
    id: "walk-dropoff",
    type: "line",
    source: "walk-dropoff",
    paint: { "line-color": "#20262d", "line-width": 3, "line-opacity": 0.72, "line-dasharray": [1, 1.6] },
    layout: { "line-cap": "round", "line-join": "round" }
  });
  map.addLayer({
    id: "navigation-completed",
    type: "line",
    source: "navigation-completed",
    paint: { "line-color": "#718078", "line-width": 7, "line-opacity": 0.88 },
    layout: { "line-cap": "round", "line-join": "round" }
  });
  map.addLayer({
    id: "navigation-remaining",
    type: "line",
    source: "navigation-remaining",
    paint: { "line-color": "#165df5", "line-width": 8 },
    layout: { "line-cap": "round", "line-join": "round" }
  });
  map.addLayer({
    id: "step-preview-casing",
    type: "line",
    source: "step-preview",
    paint: { "line-color": "#ffffff", "line-width": 12, "line-opacity": 0.95 },
    layout: { "line-cap": "round", "line-join": "round" }
  });
  map.addLayer({
    id: "step-preview",
    type: "line",
    source: "step-preview",
    paint: { "line-color": "#ef6c00", "line-width": 7 },
    layout: { "line-cap": "round", "line-join": "round" }
  });
  map.addLayer({
    id: "user-location-dot",
    type: "circle",
    source: "user-location",
    paint: {
      "circle-radius": 8,
      "circle-color": "#165df5",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3,
      "circle-opacity": 0.92
    }
  });
  map.addLayer({
    id: "user-location-pulse",
    type: "circle",
    source: "user-location",
    paint: {
      "circle-radius": 18,
      "circle-color": "#165df5",
      "circle-opacity": 0.18,
      "circle-stroke-color": "#165df5",
      "circle-stroke-width": 2,
      "circle-stroke-opacity": 0.12
    }
  });
  map.addLayer({
    id: "candidate-station-halo",
    type: "circle",
    source: "candidate-stations",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": ["case", ["==", ["get", "selected"], 1], 25, 22],
      "circle-color": "#ffffff",
      "circle-stroke-color": ["match", ["get", "kind"], "pickup", "#165df5", "#08a66c"],
      "circle-stroke-width": ["case", ["==", ["get", "selected"], 1], 4, 2],
      "circle-opacity": 0.96
    }
  });
  map.addLayer({
    id: "candidate-station-count",
    type: "symbol",
    source: "candidate-stations",
    filter: ["!", ["has", "point_count"]],
    layout: {
      "text-field": ["concat", ["to-string", ["get", "count"]], "\n", ["get", "availabilityLabel"]],
      "text-size": 9,
      "text-line-height": 0.95,
      "text-font": ["Open Sans Bold"],
      "text-allow-overlap": true,
      "text-ignore-placement": true
    },
    paint: { "text-color": ["match", ["get", "kind"], "pickup", "#165df5", "#087c55"] }
  });
  map.addLayer({
    id: "candidate-station-clusters",
    type: "circle",
    source: "candidate-stations",
    filter: ["has", "point_count"],
    paint: { "circle-radius": 23, "circle-color": "#ffffff", "circle-stroke-color": "#536169", "circle-stroke-width": 2.5, "circle-opacity": 0.96 }
  });
  map.addLayer({
    id: "candidate-station-cluster-count",
    type: "symbol",
    source: "candidate-stations",
    filter: ["has", "point_count"],
    layout: { "text-field": ["concat", ["to-string", ["get", "point_count"]], "\nSTOPS"], "text-size": 9, "text-line-height": 0.95, "text-font": ["Open Sans Bold"], "text-allow-overlap": true },
    paint: { "text-color": "#39454c" }
  });
  map.addLayer({
    id: "route-points-rings",
    type: "circle",
    source: "route-points",
    paint: {
      "circle-radius": ["match", ["get", "kind"], "pickup", 9, "dropoff", 9, 7],
      "circle-color": ["match", ["get", "kind"], "origin", "#1f2933", "destination", "#ff6257", "pickup", "#165df5", "#08a66c"],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3
    }
  });
}

function updateMapEndpoints(map: MapLibreMap, origin: Coordinate | null, destination: Coordinate | null, fit = false): void {
  (map.getSource("walk-pickup") as GeoJSONSource)?.setData(lineFeature([]));
  (map.getSource("bike-route") as GeoJSONSource)?.setData(lineFeature([]));
  (map.getSource("walk-dropoff") as GeoJSONSource)?.setData(lineFeature([]));
  (map.getSource("candidate-stations") as GeoJSONSource)?.setData({ type: "FeatureCollection", features: [] });
  (map.getSource("route-points") as GeoJSONSource)?.setData({
    type: "FeatureCollection",
    features: [
      ...(origin ? [pointFeature(origin, "origin").features[0]] : []),
      ...(destination ? [pointFeature(destination, "destination").features[0]] : [])
    ]
  });
  if (fit && origin && destination) {
    const bounds = new maplibregl.LngLatBounds();
    bounds.extend(origin);
    bounds.extend(destination);
    map.fitBounds(bounds, { padding: mapFitPadding(), maxZoom: 14.5, duration: 500 });
  }
}

function clearNavigationLayers(map: MapLibreMap): void {
  (map.getSource("navigation-completed") as GeoJSONSource)?.setData(lineFeature([]));
  (map.getSource("navigation-remaining") as GeoJSONSource)?.setData(lineFeature([]));
  (map.getSource("step-preview") as GeoJSONSource)?.setData(lineFeature([]));
}

function updateUserLocation(map: MapLibreMap, origin: Coordinate | null): void {
  (map.getSource("user-location") as GeoJSONSource)?.setData(
    origin ? pointFeature(origin, "user") : { type: "FeatureCollection", features: [] }
  );
}

function updateMapRoute(map: MapLibreMap, option: RouteOption, origin: Coordinate, destination: Coordinate, candidates: FeatureCollection): void {
  (map.getSource("walk-pickup") as GeoJSONSource).setData(lineFeature(option.legs.walk_to_pickup.coordinates));
  (map.getSource("bike-route") as GeoJSONSource).setData(lineFeature(option.legs.bike.coordinates));
  (map.getSource("walk-dropoff") as GeoJSONSource).setData(lineFeature(option.legs.walk_to_destination.coordinates));
  (map.getSource("route-points") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: [
      pointFeature(origin, "origin").features[0],
      pointFeature(destination, "destination").features[0]
    ]
  });
  (map.getSource("candidate-stations") as GeoJSONSource).setData(candidates);
  const bounds = new maplibregl.LngLatBounds();
  for (const coordinate of allCoordinates(option)) bounds.extend(coordinate);
  map.fitBounds(bounds, { padding: mapFitPadding(), maxZoom: 15, duration: 700 });
}

function StepIcon({ step }: { step: RouteStep }) {
  if (step.maneuver === "arrive") return <MapPin size={18} />;
  if (step.maneuver === "depart") return <Navigation size={18} />;
  if (step.maneuver.includes("left")) return <Undo2 className="turn-left" size={18} />;
  if (step.maneuver.includes("right")) return <Undo2 className="turn-right" size={18} />;
  return <ChevronRight size={18} />;
}

function TurnList({ option, onClose, onPreview, onStart }: { option: RouteOption; onClose: () => void; onPreview: (step: NavigationStep) => void; onStart: () => void }) {
  const groups: Array<{ label: string; icon: typeof Bike; leg: RouteLeg }> = [
    { label: "Walk to BIXI", icon: Route, leg: option.legs.walk_to_pickup },
    { label: "Ride", icon: Bike, leg: option.legs.bike },
    { label: "Walk to destination", icon: Route, leg: option.legs.walk_to_destination }
  ];
  return (
    <div className="turn-sheet" role="dialog" aria-label="Route directions">
      <header className="turn-header">
        <div><span>Directions</span><strong>{option.estimated_total_minutes} min total</strong></div>
        <div className="turn-header-actions">
          <button type="button" className="start-navigation-button" onClick={onStart}><Navigation size={16} fill="currentColor" />Start</button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close directions"><X size={20} /></button>
        </div>
      </header>
      <div className="turn-scroll">
        {groups.map(({ label, icon: Icon, leg }) => (
          <section className="turn-group" key={label}>
            <h3><Icon size={17} />{label}<span>{formatDistance(leg.distance_m)}</span></h3>
            {leg.steps.map((step, index) => {
              const start = nearestCoordinateIndex(leg.coordinates, step.coordinate);
              const nextStep = leg.steps[index + 1];
              const end = nextStep ? nearestCoordinateIndex(leg.coordinates, nextStep.coordinate) : leg.coordinates.length - 1;
              const navigationStep: NavigationStep = { step, leg, mode: label === "Ride" ? "bike" : "walk", segment: leg.coordinates.slice(Math.min(start, end), Math.max(start, end) + 1) };
              return <button type="button" className="turn-row" key={`${label}-${step.instruction}-${step.distance_m}-${index}`} onClick={() => onPreview(navigationStep)}>
                <span className="turn-icon"><StepIcon step={step} /></span>
                <span><strong>{step.instruction}</strong>{step.distance_m > 0 && <small>{formatDistance(step.distance_m)}</small>}<ChevronRight size={15} /></span>
              </button>;
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

function Wordmark() {
  return (
    <div className="wordmark">
      <img src="/icon-1024.png" alt="" />
      <span>Detour</span>
      <small>Montréal</small>
    </div>
  );
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const searchRef = useRef<AbortController | null>(null);
  const originSearchRef = useRef<AbortController | null>(null);
  const navigationWatchRef = useRef<number | null>(null);
  const previewTouchStartRef = useRef<number | null>(null);
  const navigationTouchStartRef = useRef<number | null>(null);
  const [origin, setOrigin] = useState<Coordinate | null>(null);
  const [destination, setDestination] = useState<Coordinate | null>(null);
  const [destinationName, setDestinationName] = useState("");
  const [originLabel, setOriginLabel] = useState("Set start location");
  const [originFocused, setOriginFocused] = useState(false);
  const [originSearchQuery, setOriginSearchQuery] = useState("");
  const [originSearchResults, setOriginSearchResults] = useState<PlaceResult[]>([]);
  const [originSearching, setOriginSearching] = useState(false);
  const [gpsField, setGpsField] = useState<"origin" | "destination" | null>(null);
  const [preference, setPreference] = useState<BikePreference>("any");
  const [routes, setRoutes] = useState<RouteResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapPickMode, setMapPickMode] = useState<"origin" | "destination" | null>(null);
  const [showTurns, setShowTurns] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [destinationFocused, setDestinationFocused] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedMapStation, setSelectedMapStation] = useState<NearbyStation | null>(null);
  const [viewMode, setViewMode] = useState<"plan" | "explore">("plan");
  const [explorerStations, setExplorerStations] = useState<BixiStation[]>([]);
  const [explorerUpdatedAt, setExplorerUpdatedAt] = useState<string | undefined>();
  const [explorerLoading, setExplorerLoading] = useState(false);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [explorerFilter, setExplorerFilter] = useState<"all" | "bikes" | "docks">("all");
  const [selectedExplorerStation, setSelectedExplorerStation] = useState<BixiStation | null>(null);
  const [navigationActive, setNavigationActive] = useState(false);
  const [navigationLocation, setNavigationLocation] = useState<Coordinate | null>(null);
  const [navigationStepIndex, setNavigationStepIndex] = useState(0);
  const [navigationAccuracy, setNavigationAccuracy] = useState<number | null>(null);
  const [navigationBrowseIndex, setNavigationBrowseIndex] = useState<number | null>(null);
  const [previewedStep, setPreviewedStep] = useState<NavigationStep | null>(null);
  const [previewedStepIndex, setPreviewedStepIndex] = useState<number | null>(null);
  const selectedRoute = routes?.options[selectedIndex];
  const navigationSteps = useMemo(() => selectedRoute ? routeSteps(selectedRoute) : [], [selectedRoute]);
  const currentNavigationStep = navigationSteps[navigationStepIndex];
  const displayedNavigationStep = navigationBrowseIndex === null ? currentNavigationStep : navigationSteps[navigationBrowseIndex];

  const requestRoutes = useCallback(async (nextOrigin: Coordinate | null = origin, nextDestination: Coordinate | null = destination, nextPreference: BikePreference = preference, stationChoice?: { kind: "pickup" | "dropoff"; stationId: string }) => {
    if (!nextOrigin || !nextDestination) return;
    if (!inCoverage(nextOrigin) || !inCoverage(nextDestination)) {
      setRoutes(null);
      setError("That point is outside central Montréal coverage. Try Mile End, Plateau, or Jean-Talon.");
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    setShowTurns(false);
    setRoutes(null);
    setSelectedMapStation(null);
    try {
      const response = await fetchRoutes(nextOrigin, nextDestination, nextPreference, controller.signal, stationChoice);
      setRoutes(response);
      setSelectedIndex(0);
      setSelectedMapStation(null);
      setPreviewedStep(null);
      setPreviewedStepIndex(null);
    } catch (requestError) {
      if ((requestError as Error).name !== "AbortError") {
        const message = (requestError as Error).message;
        setError(
          message.includes("prepared routing coverage")
            ? "That point is outside central Montréal coverage. Try Mile End, Plateau, or Jean-Talon."
            : message
        );
      }
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, [destination, origin, preference]);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_STYLE,
      center: MAP_CENTER,
      zoom: 12.4,
      attributionControl: false
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("load", () => { addRouteLayers(map); setMapReady(true); });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const selectCandidate = (event: maplibregl.MapLayerMouseEvent) => {
      const properties = event.features?.[0]?.properties;
      if (viewMode === "explore") {
        const station = explorerStations.find((candidate) => candidate.station_id === properties?.stationId);
        if (station) setSelectedExplorerStation(station);
      } else {
        const station = routes?.nearby_stations?.find((candidate) => candidate.station_id === properties?.stationId && candidate.kind === properties?.kind);
        if (station) setSelectedMapStation(station);
      }
    };
    const showPointer = () => { map.getCanvas().style.cursor = "pointer"; };
    const hidePointer = () => { map.getCanvas().style.cursor = ""; };
    map.on("click", "candidate-station-halo", selectCandidate);
    const expandCluster = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const clusterId = Number(feature?.properties?.cluster_id);
      const coordinates = feature?.geometry.type === "Point" ? feature.geometry.coordinates as Coordinate : null;
      const source = map.getSource("candidate-stations") as GeoJSONSource;
      if (!Number.isFinite(clusterId) || !coordinates) return;
      void source.getClusterExpansionZoom(clusterId).then((zoom) => map.easeTo({ center: coordinates, zoom, duration: 500 }));
    };
    map.on("click", "candidate-station-clusters", expandCluster);
    map.on("mouseenter", "candidate-station-halo", showPointer);
    map.on("mouseleave", "candidate-station-halo", hidePointer);
    map.on("mouseenter", "candidate-station-clusters", showPointer);
    map.on("mouseleave", "candidate-station-clusters", hidePointer);
    return () => {
      map.off("click", "candidate-station-halo", selectCandidate);
      map.off("click", "candidate-station-clusters", expandCluster);
      map.off("mouseenter", "candidate-station-halo", showPointer);
      map.off("mouseleave", "candidate-station-halo", hidePointer);
      map.off("mouseenter", "candidate-station-clusters", showPointer);
      map.off("mouseleave", "candidate-station-clusters", hidePointer);
    };
  }, [explorerStations, mapReady, routes, viewMode]);

  useEffect(() => {
    if (viewMode !== "explore") return;
    const controller = new AbortController();
    setExplorerLoading(true);
    setError(null);
    void fetchBixiStations(controller.signal)
      .then((response) => { setExplorerStations(response.stations); setExplorerUpdatedAt(response.generated_at); })
      .catch((requestError) => { if ((requestError as Error).name !== "AbortError") setError((requestError as Error).message); })
      .finally(() => setExplorerLoading(false));
    return () => controller.abort();
  }, [explorerRefreshKey, viewMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handleClick = (event: maplibregl.MapMouseEvent) => {
      if (!mapPickMode) return;
      const coordinate: Coordinate = [event.lngLat.lng, event.lngLat.lat];
      const pickedField = mapPickMode;
      setMapPickMode(null);
      if (pickedField === "origin") {
        setOrigin(coordinate);
        setOriginLabel("Locating…");
        setOriginSearchQuery("");
      } else {
        setDestination(coordinate);
        setDestinationName("Locating…");
        setSearchQuery("");
      }
      void reverseGeocode(coordinate).then((place) => {
        if (pickedField === "origin") {
          setOriginLabel(place.name);
          setOriginSearchQuery(place.name);
        } else {
          setDestinationName(place.name);
          setSearchQuery(place.name);
        }
        if (!inCoverage(place)) {
          setRoutes(null);
          setError("That point is outside central Montréal coverage. Try Mile End, Plateau, or Jean-Talon.");
        }
      });
      if (pickedField === "origin" && destination) void requestRoutes(coordinate, destination);
      if (pickedField === "destination" && origin) void requestRoutes(origin, coordinate);
    };
    map.on("click", handleClick);
    return () => { map.off("click", handleClick); };
  }, [mapPickMode, origin, requestRoutes]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    updateUserLocation(mapRef.current, origin);
    if (viewMode === "explore") {
      (mapRef.current.getSource("walk-pickup") as GeoJSONSource)?.setData(lineFeature([]));
      (mapRef.current.getSource("bike-route") as GeoJSONSource)?.setData(lineFeature([]));
      (mapRef.current.getSource("walk-dropoff") as GeoJSONSource)?.setData(lineFeature([]));
      (mapRef.current.getSource("route-points") as GeoJSONSource)?.setData({ type: "FeatureCollection", features: [] });
      (mapRef.current.getSource("candidate-stations") as GeoJSONSource)?.setData(explorerStationFeatures(explorerStations, preference, explorerFilter, selectedExplorerStation?.station_id ?? null));
      return;
    }
    if (!selectedRoute || !origin || !destination) {
      updateMapEndpoints(mapRef.current, origin, destination, loading);
      return;
    }
    updateMapRoute(mapRef.current, selectedRoute, origin, destination, stationFeatures(routes, selectedIndex, preference));
  }, [destination, explorerFilter, explorerStations, loading, mapReady, origin, preference, routes, selectedExplorerStation, selectedIndex, selectedRoute, viewMode]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    updateUserLocation(mapRef.current, navigationLocation ?? origin);
  }, [mapReady, navigationLocation, origin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!navigationActive || !navigationLocation || !selectedRoute || !mapReady || !map) return;
    const coordinates = allCoordinates(selectedRoute);
    const progressIndex = nearestCoordinateIndex(coordinates, navigationLocation);
    (map.getSource("navigation-completed") as GeoJSONSource).setData(lineFeature(coordinates.slice(0, Math.max(2, progressIndex + 1))));
    (map.getSource("navigation-remaining") as GeoJSONSource).setData(lineFeature(coordinates.slice(Math.max(0, progressIndex), coordinates.length)));
    if (navigationBrowseIndex === null) (map.getSource("step-preview") as GeoJSONSource).setData(lineFeature([]));

    let nextStepIndex = 0;
    navigationSteps.forEach((entry, index) => {
      const entryRouteIndex = nearestCoordinateIndex(coordinates, entry.step.coordinate);
      if (entryRouteIndex <= progressIndex + 1) nextStepIndex = index;
    });
    setNavigationStepIndex(Math.min(nextStepIndex, navigationSteps.length - 1));
    if (navigationBrowseIndex === null) map.easeTo({ center: navigationLocation, zoom: 17, pitch: 48, bearing: routeBearing(coordinates, progressIndex), duration: 700, padding: { top: 150, bottom: 190, left: 40, right: 40 } });
  }, [mapReady, navigationActive, navigationBrowseIndex, navigationLocation, navigationSteps, selectedRoute]);

  useEffect(() => {
    const map = mapRef.current;
    if (!navigationActive || navigationBrowseIndex === null || !map) return;
    const entry = navigationSteps[navigationBrowseIndex];
    if (!entry || entry.segment.length < 2) return;
    (map.getSource("step-preview") as GeoJSONSource)?.setData(lineFeature(entry.segment));
    const bounds = new maplibregl.LngLatBounds();
    entry.segment.forEach((coordinate) => bounds.extend(coordinate));
    map.fitBounds(bounds, { padding: { top: 170, right: 48, bottom: 120, left: 48 }, maxZoom: 18, duration: 550, pitch: 20 });
  }, [navigationActive, navigationBrowseIndex, navigationSteps]);

  useEffect(() => () => {
    if (navigationWatchRef.current !== null) navigator.geolocation.clearWatch(navigationWatchRef.current);
  }, []);

  useEffect(() => {
    if (!destinationFocused) return;
    const term = searchQuery.trim();
    if (term.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    searchRef.current?.abort();
    const controller = new AbortController();
    searchRef.current = controller;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchPlaces(term, controller.signal)
        .then((results) => {
          if (searchRef.current === controller) setSearchResults(results);
        })
        .catch((searchError) => {
          if ((searchError as Error).name !== "AbortError" && searchRef.current === controller) {
            setSearchResults([]);
          }
        })
        .finally(() => {
          if (searchRef.current === controller) setSearching(false);
        });
    }, 280);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [destinationFocused, searchQuery]);

  useEffect(() => {
    if (!originFocused) return;
    const term = originSearchQuery.trim();
    if (term.length < 2) {
      setOriginSearchResults([]);
      setOriginSearching(false);
      return;
    }
    originSearchRef.current?.abort();
    const controller = new AbortController();
    originSearchRef.current = controller;
    setOriginSearching(true);
    const timer = window.setTimeout(() => {
      void searchPlaces(term, controller.signal)
        .then((results) => { if (originSearchRef.current === controller) setOriginSearchResults(results); })
        .catch((searchError) => { if ((searchError as Error).name !== "AbortError" && originSearchRef.current === controller) setOriginSearchResults([]); })
        .finally(() => { if (originSearchRef.current === controller) setOriginSearching(false); });
    }, 280);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [originFocused, originSearchQuery]);

  const useGpsLocation = (field: "origin" | "destination") => {
    if (!navigator.geolocation) { setError("Location is not available on this device."); return; }
    setGpsField(field);
    if (field === "origin") setOriginLabel("Locating…");
    else setDestinationName("Locating…");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const coordinate: Coordinate = [coords.longitude, coords.latitude];
        setGpsField(null);
        mapRef.current?.flyTo({ center: coordinate, zoom: 14 });
        if (field === "origin") {
          setOrigin(coordinate);
          setOriginLabel("Current location");
          setOriginSearchQuery("Current location");
          if (destination) void requestRoutes(coordinate, destination);
        } else {
          setDestination(coordinate);
          setDestinationName("Current location");
          setSearchQuery("Current location");
          if (origin) void requestRoutes(origin, coordinate);
        }
      },
      () => {
        setGpsField(null);
        if (field === "origin") setOriginLabel(origin ? originLabel : "Set start location");
        else setDestinationName(destination ? destinationName : "");
        setError("We could not access your location. Check browser permissions.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const selectPlace = (place: PlaceResult) => {
    setDestination(place.coordinate);
    setDestinationName(place.name);
    setSearchQuery(place.name);
    setDestinationFocused(false);
    setSearchResults([]);
    mapRef.current?.flyTo({ center: place.coordinate, zoom: 14 });
    if (!inCoverage(place)) {
      setRoutes(null);
      setError("That place is outside central Montréal coverage. Try Mile End, Plateau, or Jean-Talon.");
      return;
    }
    if (origin) void requestRoutes(origin, place.coordinate);
    else setError("Set your start location to find BIXI routes.");
  };

  const selectOriginPlace = (place: PlaceResult) => {
    setOrigin(place.coordinate);
    setOriginLabel(place.name);
    setOriginSearchQuery(place.name);
    setOriginFocused(false);
    setOriginSearchResults([]);
    mapRef.current?.flyTo({ center: place.coordinate, zoom: 14 });
    if (!inCoverage(place)) {
      setRoutes(null);
      setError("That start is outside central Montréal coverage. Try Mile End, Plateau, or Jean-Talon.");
      return;
    }
    if (destination) void requestRoutes(place.coordinate, destination);
  };

  const swapLocations = () => {
    const nextOrigin = destination;
    const nextDestination = origin;
    const nextOriginLabel = destination ? (destinationName || "Selected destination") : "Set start location";
    const nextDestinationName = origin ? originLabel : "";
    setOrigin(nextOrigin);
    setDestination(nextDestination);
    setOriginLabel(nextOriginLabel);
    setDestinationName(nextDestinationName);
    setOriginSearchQuery(nextOrigin ? nextOriginLabel : "");
    setSearchQuery(nextDestinationName);
    setOriginFocused(false);
    setDestinationFocused(false);
    setSelectedMapStation(null);
    setPreviewedStep(null);
    setPreviewedStepIndex(null);
    if (nextOrigin && nextDestination) void requestRoutes(nextOrigin, nextDestination);
    else setRoutes(null);
  };

  const clearLocation = (field: "origin" | "destination") => {
    requestRef.current?.abort();
    setLoading(false);
    setRoutes(null);
    setSelectedMapStation(null);
    setPreviewedStep(null);
    setPreviewedStepIndex(null);
    if (field === "origin") {
      setOrigin(null);
      setOriginLabel("Set start location");
      setOriginSearchQuery("");
    } else {
      setDestination(null);
      setDestinationName("");
      setSearchQuery("");
    }
  };

  const previewStep = (entry: NavigationStep) => {
    const map = mapRef.current;
    if (!map || entry.segment.length < 2) return;
    (map.getSource("step-preview") as GeoJSONSource)?.setData(lineFeature(entry.segment));
    setPreviewedStep(entry);
    const index = navigationSteps.findIndex((candidate) => candidate.step === entry.step || (
      candidate.step.instruction === entry.step.instruction && candidate.step.coordinate[0] === entry.step.coordinate[0] && candidate.step.coordinate[1] === entry.step.coordinate[1]
    ));
    setPreviewedStepIndex(index >= 0 ? index : null);
    if (window.innerWidth < DESKTOP_BREAKPOINT) setShowTurns(false);
    const bounds = new maplibregl.LngLatBounds();
    entry.segment.forEach((coordinate) => bounds.extend(coordinate));
    map.fitBounds(bounds, { padding: window.innerWidth >= DESKTOP_BREAKPOINT ? { top: 100, right: 400, bottom: 100, left: SIDEBAR_WIDTH + 55 } : { top: 100, right: 55, bottom: 120, left: 55 }, maxZoom: 18, duration: 650 });
  };

  const jumpPreview = (direction: -1 | 1) => {
    if (previewedStepIndex === null || navigationSteps.length === 0) return;
    const nextIndex = Math.min(navigationSteps.length - 1, Math.max(0, previewedStepIndex + direction));
    if (nextIndex !== previewedStepIndex) previewStep(navigationSteps[nextIndex]);
  };

  const startNavigation = () => {
    if (!selectedRoute || !navigator.geolocation) { setError("Live navigation requires location access on this device."); return; }
    if (navigationWatchRef.current !== null) navigator.geolocation.clearWatch(navigationWatchRef.current);
    setShowTurns(false);
    setPreviewedStep(null);
    setPreviewedStepIndex(null);
    setNavigationActive(true);
    setNavigationStepIndex(0);
    setNavigationBrowseIndex(null);
    setPreviewedStep(null);
    setPreviewedStepIndex(null);
    navigationWatchRef.current = navigator.geolocation.watchPosition(
      ({ coords }) => {
        setNavigationLocation([coords.longitude, coords.latitude]);
        setNavigationAccuracy(coords.accuracy);
      },
      () => {
        setNavigationActive(false);
        setError("Live navigation could not access your location. Check browser permissions and try again.");
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 }
    );
  };

  const stopNavigation = () => {
    if (navigationWatchRef.current !== null) navigator.geolocation.clearWatch(navigationWatchRef.current);
    navigationWatchRef.current = null;
    setNavigationActive(false);
    setNavigationLocation(null);
    setNavigationAccuracy(null);
    setNavigationStepIndex(0);
    setNavigationBrowseIndex(null);
    if (mapRef.current) {
      clearNavigationLayers(mapRef.current);
      mapRef.current.easeTo({ pitch: 0, bearing: 0, duration: 450 });
      if (selectedRoute && origin && destination) updateMapRoute(mapRef.current, selectedRoute, origin, destination, stationFeatures(routes, selectedIndex, preference));
    }
  };

  const showResults = destinationFocused;
  const displayResults = searchQuery.trim().length < 2 ? SUGGESTED_PLACES : searchResults;
  const originDisplayResults = originSearchQuery.trim().length < 2 ? SUGGESTED_PLACES : originSearchResults;

  return (
    <main className={`app-shell ${mapPickMode ? "is-picking" : ""} ${navigationActive ? "navigating" : ""}`}>
      <div ref={mapContainer} className="map" aria-label="Detour route map" />

      <header className="top-bar">
        <div className="mobile-brand"><Wordmark /></div>
        <button type="button" className="mode-button" aria-pressed={viewMode === "explore"} onClick={() => { setViewMode(viewMode === "plan" ? "explore" : "plan"); setSelectedMapStation(null); setSelectedExplorerStation(null); }}>
          <CircleParking size={17} />{viewMode === "plan" ? "Explore BIXI" : "Plan a trip"}
        </button>
        <button type="button" className="icon-button coverage-button" aria-label="Center map" onClick={() => mapRef.current?.flyTo({ center: origin ?? MAP_CENTER, zoom: origin ? 14 : 12.4 })}>
          <Crosshair size={19} />
        </button>
      </header>

      {window.innerWidth < DESKTOP_BREAKPOINT && (originFocused || destinationFocused) && (
        <section className="mobile-location-picker" role="dialog" aria-modal="true" aria-label={originFocused ? "Choose start location" : "Choose destination"}>
          <header>
            <button type="button" onClick={() => { setOriginFocused(false); setDestinationFocused(false); }} aria-label="Close location search"><ChevronLeft size={21} /></button>
            <div><small>{originFocused ? "START" : "DESTINATION"}</small><strong>{originFocused ? "Choose a start" : "Choose a destination"}</strong></div>
          </header>
          <div className="mobile-location-search">
            <Search size={19} />
            <input autoFocus value={originFocused ? originSearchQuery : searchQuery} onChange={(event) => originFocused ? setOriginSearchQuery(event.target.value) : setSearchQuery(event.target.value)} aria-label={originFocused ? "Search start location" : "Search destination"} placeholder="Search places" autoComplete="off" spellCheck={false} />
            {(originFocused ? originSearchQuery : searchQuery) && <button type="button" onClick={() => originFocused ? setOriginSearchQuery("") : setSearchQuery("")} aria-label="Clear search"><X size={16} /></button>}
          </div>
          <div className="mobile-picker-actions">
            <button type="button" onClick={() => { const field = originFocused ? "origin" : "destination"; setOriginFocused(false); setDestinationFocused(false); useGpsLocation(field); }}>
              {gpsField === (originFocused ? "origin" : "destination") ? <Loader2 className="spin" size={19} /> : <LocateFixed size={19} />}<span><strong>Current location</strong><small>Use device GPS</small></span>
            </button>
            <button type="button" onClick={() => { const field = originFocused ? "origin" : "destination"; setOriginFocused(false); setDestinationFocused(false); setMapPickMode(field); }}>
              <MapPin size={19} /><span><strong>Pick on map</strong><small>Drop a pin</small></span>
            </button>
          </div>
          <div className="mobile-picker-results">
            <div className="place-results-label">{(originFocused ? originSearchQuery : searchQuery).trim().length < 2 ? "Popular nearby" : "Search results"}</div>
            {(originFocused ? originSearching : searching) && <div className="place-results-status"><Loader2 className="spin" size={15} />Searching…</div>}
            {!(originFocused ? originSearching : searching) && (originFocused ? originDisplayResults : displayResults).length === 0 && <div className="place-results-status">No places found in central Montréal</div>}
            {(originFocused ? originDisplayResults : displayResults).map((place) => {
              const covered = inCoverage(place);
              return <button type="button" key={place.id} className={covered ? undefined : "out-of-coverage"} onClick={() => originFocused ? selectOriginPlace(place) : selectPlace(place)}>
                <MapPin size={17} /><span><strong>{place.name}</strong><small>{covered ? place.detail : "Outside current coverage"}</small></span><ChevronRight size={17} />
              </button>;
            })}
          </div>
        </section>
      )}

      {loading && (
        <div className="route-loading-banner" role="status" aria-live="polite">
          <Loader2 className="spin" size={17} />
          <span><strong>Finding your BIXI route</strong><small>Checking live bikes, docks, and comfortable streets…</small></span>
        </div>
      )}

      {viewMode === "plan" && <section className="planner" aria-label="Route planner">
        <div className="planner-handle" />
        <div className="planner-brand"><Wordmark /></div>
        <div className="location-stack">
          <span className="location-rail"><CircleDot size={15} /><button type="button" onClick={swapLocations} aria-label="Swap start and destination"><ArrowUpDown size={14} /></button><MapPin size={16} /></span>
          <div className="location-fields">
            <div className={`location-field origin-field ${origin ? "has-value" : ""}`}>
              <Search size={17} />
              <span>
                <small>START</small>
                <input
                  value={originFocused ? originSearchQuery : originLabel}
                  onChange={(event) => { setOriginSearchQuery(event.target.value); if (!originFocused) setOriginFocused(true); }}
                  onFocus={() => { setDestinationFocused(false); setOriginFocused(true); setOriginSearchQuery(origin ? originLabel : ""); }}
                  onBlur={() => { if (window.innerWidth >= DESKTOP_BREAKPOINT) window.setTimeout(() => setOriginFocused(false), 120); }}
                  aria-label="Start location"
                  placeholder="Choose a start"
                  autoComplete="off"
                  spellCheck={false}
                />
              </span>
              {origin && <button type="button" className="clear-location-button" onMouseDown={(event) => event.preventDefault()} onClick={() => clearLocation("origin")} aria-label="Clear start location"><X size={15} /></button>}
              {originFocused && (
                <div className="place-results origin-results desktop-place-results">
                  <button type="button" className="current-location-result" onMouseDown={(event) => event.preventDefault()} onClick={() => { setOriginFocused(false); useGpsLocation("origin"); }}>
                    {gpsField === "origin" ? <Loader2 className="spin" size={16} /> : <LocateFixed size={16} />}<span><strong>Current location</strong><small>Use this device’s GPS</small></span>
                  </button>
                  <button type="button" className="place-map-pick" onMouseDown={(event) => event.preventDefault()} onClick={() => { setOriginFocused(false); setMapPickMode("origin"); }}>
                    <MapPin size={16} /><span><strong>Pick on map</strong><small>Central Montréal pilot area</small></span>
                  </button>
                  {originSearchQuery.trim().length < 2 && <div className="place-results-label">Popular nearby</div>}
                  {originSearching && <div className="place-results-status"><Loader2 className="spin" size={15} />Searching…</div>}
                  {!originSearching && originSearchQuery.trim().length >= 2 && originDisplayResults.length === 0 && <div className="place-results-status">No places found in central Montréal</div>}
                  {originDisplayResults.map((place) => {
                    const covered = inCoverage(place);
                    return <button type="button" key={place.id} className={covered ? undefined : "out-of-coverage"} onMouseDown={(event) => event.preventDefault()} onClick={() => selectOriginPlace(place)}>
                      <MapPin size={16} /><span><strong>{place.name}</strong><small>{covered ? place.detail : "Outside current coverage"}</small></span>
                    </button>;
                  })}
                </div>
              )}
            </div>
            <div className="destination-field">
              <Search size={18} />
              <input
                value={destinationFocused ? searchQuery : destinationName}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  if (!destinationFocused) setDestinationFocused(true);
                }}
                onFocus={() => {
                  setOriginFocused(false);
                  setDestinationFocused(true);
                  setSearchQuery(destinationName === "Locating…" ? "" : destinationName);
                }}
                onBlur={() => { if (window.innerWidth >= DESKTOP_BREAKPOINT) window.setTimeout(() => setDestinationFocused(false), 120); }}
                aria-label="Destination"
                placeholder="Where to?"
                autoComplete="off"
                spellCheck={false}
              />
              {destination && <button type="button" className="clear-location-button" onMouseDown={(event) => event.preventDefault()} onClick={() => clearLocation("destination")} aria-label="Clear destination"><X size={15} /></button>}
              {showResults && (
                <div className="place-results desktop-place-results">
                  <button type="button" className="current-location-result" onMouseDown={(event) => event.preventDefault()} onClick={() => { setDestinationFocused(false); useGpsLocation("destination"); }}>
                    {gpsField === "destination" ? <Loader2 className="spin" size={16} /> : <LocateFixed size={16} />}<span><strong>Current location</strong><small>Use this device’s GPS</small></span>
                  </button>
                  <button type="button" className="place-map-pick" onMouseDown={(event) => event.preventDefault()} onClick={() => { setDestinationFocused(false); setMapPickMode("destination"); }}>
                    <MapPin size={16} /><span><strong>Pick on map</strong><small>Central Montréal pilot area</small></span>
                  </button>
                  {searchQuery.trim().length < 2 && (
                    <div className="place-results-label">Popular nearby</div>
                  )}
                  {searching && (
                    <div className="place-results-status"><Loader2 className="spin" size={15} />Searching…</div>
                  )}
                  {!searching && searchQuery.trim().length >= 2 && displayResults.length === 0 && (
                    <div className="place-results-status">No places found in central Montréal — try Mile End or Plateau</div>
                  )}
                  {displayResults.map((place) => {
                    const covered = inCoverage(place);
                    return (
                      <button type="button" key={place.id} className={covered ? undefined : "out-of-coverage"} onMouseDown={(event) => event.preventDefault()} onClick={() => selectPlace(place)}>
                        <MapPin size={16} /><span><strong>{place.name}</strong><small>{covered ? place.detail : "Outside current coverage"}</small></span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="preference-row">
          <span>Bike</span>
          <div className={`segmented preference-${preference}`} aria-label="Bike preference">
            {(["any", "ebike", "regular"] as BikePreference[]).map((value) => (
              <button type="button" key={value} className={preference === value ? "active" : ""} aria-pressed={preference === value} onClick={() => {
                setPreference(value);
                if (origin && destination) void requestRoutes(origin, destination, value);
              }}>
                {value === "ebike" && <Zap size={12} fill="currentColor" />}
                {value === "any" ? "Any" : value === "ebike" ? "E-bike" : "Regular"}
              </button>
            ))}
          </div>
          <button type="button" className="refresh-button" onClick={() => void requestRoutes()} disabled={loading} aria-label="Refresh routes">
            <RefreshCw className={loading ? "spin" : ""} size={18} />
          </button>
        </div>

        {error && <div className="error-banner"><span>{error}</span><button type="button" onClick={() => setError(null)}><X size={17} /></button></div>}

        <div className="results-head">
          <span>
            {loading
              ? "Finding live BIXI routes..."
              : routes
                ? `${routes.options.length} live options`
                : !origin
                  ? "Set start, then pick a destination"
                  : !destination
                    ? "Search or pick a destination"
                    : "Plan a BIXI trip"}
          </span>
          {routes && <small>{timeAgo(routes.generated_at)}</small>}
        </div>

        <div className="route-options" aria-live="polite">
          {loading && !routes && [0, 1, 2].map((value) => <div className="route-skeleton" key={value} />)}
          {routes?.options.map((option, index) => (
            <button type="button" className={`route-option ${selectedIndex === index ? "selected" : ""}`} key={`${option.pickup.station_id}-${option.dropoff.station_id}`} onClick={() => setSelectedIndex(index)}>
              <span className="option-rank">{index + 1}</span>
              <span className="option-main">
                <strong>{option.estimated_total_minutes} min</strong>
                <small><Route size={14} /> {formatDistance(option.total_walk_m)} walk <i /> Comfort {option.comfort_score}</small>
              </span>
              <span className="availability">
                {preference === "any" ? (
                  <span className="bike-split" aria-label={`${option.pickup.available_regular_bikes} regular bikes and ${option.pickup.available_ebikes} e-bikes`}>
                    <Bike size={15} /><strong>{option.pickup.available_regular_bikes}</strong><Zap size={12} fill="currentColor" /><strong>{option.pickup.available_ebikes}</strong>
                  </span>
                ) : (
                  <span className={preference === "ebike" ? "ebike-count" : undefined}>
                    {preference === "ebike" ? <Zap size={14} fill="currentColor" /> : <Bike size={15} />}
                    <strong>{preference === "ebike" ? option.pickup.available_ebikes : option.pickup.available_regular_bikes}</strong>
                  </span>
                )}
                <span className="dock-icon" aria-label="Open docks"><CircleParking size={13} strokeWidth={2.4} /></span>
                <strong>{option.dropoff.available_docks}</strong>
              </span>
              <ChevronRight size={18} />
            </button>
          ))}
        </div>

        {selectedRoute && (
          <div className="mobile-route-actions">
            <button type="button" className="route-preview-button" onClick={() => setShowTurns(true)}><Route size={17} /><span>Preview</span></button>
            <button type="button" className="mobile-directions-button" onClick={startNavigation}>
              <Navigation size={17} fill="currentColor" /><span>Start</span><strong>{selectedRoute.estimated_total_minutes} min</strong><ChevronRight size={17} />
            </button>
          </div>
        )}

        {selectedRoute && (
          <div className="station-strip">
            <div><span className="station-dot pickup-dot" /><span><small>Pick up · {timeAgo(selectedRoute.pickup.availability_updated_at)}</small><strong>{selectedRoute.pickup.name}</strong><em>{selectedRoute.pickup.available_regular_bikes} regular · {selectedRoute.pickup.available_ebikes} e-bikes</em></span></div>
            <div><span className="station-dot dropoff-dot" /><span><small>Return · {timeAgo(selectedRoute.dropoff.availability_updated_at)}</small><strong>{selectedRoute.dropoff.name}</strong><em>{selectedRoute.dropoff.available_docks} open docks</em></span></div>
            <div className="desktop-route-actions">
              <button type="button" className="route-preview-button" onClick={() => setShowTurns(true)}><Route size={17} /><span>Preview</span></button>
              <button type="button" className="directions-button" onClick={startNavigation}><Navigation size={18} fill="currentColor" /><span>Start navigation</span><ChevronRight size={17} /></button>
            </div>
          </div>
        )}
      </section>}

      {viewMode === "explore" && (
        <section className="explorer-panel" aria-label="BIXI station explorer">
          <div className="planner-handle" />
          <div className="explorer-head"><span><small>Live BIXI network</small><strong>{explorerLoading ? "Loading stations…" : `${explorerStations.length} stations`}</strong></span><button type="button" className="refresh-button" onClick={() => setExplorerRefreshKey((key) => key + 1)} disabled={explorerLoading} aria-label="Refresh station availability"><RefreshCw className={explorerLoading ? "spin" : ""} size={18} /></button></div>
          <div className="explorer-filters" aria-label="Station availability filter">
            {(["all", "bikes", "docks"] as const).map((filter) => <button type="button" key={filter} className={explorerFilter === filter ? "active" : ""} onClick={() => setExplorerFilter(filter)}>{filter === "all" ? "All stations" : filter === "bikes" ? "Has bikes" : "Has docks"}</button>)}
          </div>
          <p>{explorerLoading ? "Checking the live BIXI feed…" : `Tap a point for availability${explorerUpdatedAt ? ` · ${timeAgo(explorerUpdatedAt)}` : ""}`}</p>
        </section>
      )}

      {navigationActive && displayedNavigationStep && selectedRoute && (
        <section className="navigation-hud" aria-label="Live navigation">
          <div className="navigation-instruction" onTouchStart={(event) => { navigationTouchStartRef.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={(event) => {
            const start = navigationTouchStartRef.current;
            const end = event.changedTouches[0]?.clientX;
            navigationTouchStartRef.current = null;
            if (start === null || end === undefined || Math.abs(end - start) < 45) return;
            const base = navigationBrowseIndex ?? navigationStepIndex;
            setNavigationBrowseIndex(Math.min(navigationSteps.length - 1, Math.max(0, base + (end < start ? 1 : -1))));
          }}>
            <span className="navigation-maneuver"><StepIcon step={displayedNavigationStep.step} /></span>
            <span><small>{navigationBrowseIndex === null ? "Live" : `Previewing ${navigationBrowseIndex + 1}/${navigationSteps.length}`} · {displayedNavigationStep.mode === "bike" ? "Ride" : "Walk"} · {formatDistance(displayedNavigationStep.step.distance_m)}</small><strong>{displayedNavigationStep.step.instruction}</strong></span>
            <button type="button" onClick={stopNavigation} aria-label="Stop navigation"><X size={20} /></button>
          </div>
          <div className="navigation-progress"><span style={{ width: `${Math.max(4, ((navigationStepIndex + 1) / Math.max(1, navigationSteps.length)) * 100)}%` }} /></div>
          <div className="navigation-footer">
            <span><strong>{selectedRoute.estimated_total_minutes} min</strong><small>estimated</small></span>
            <span><strong>{navigationStepIndex + 1}/{navigationSteps.length}</strong><small>steps</small></span>
            <span><strong>{navigationAccuracy ? `±${Math.round(navigationAccuracy)} m` : "Locating…"}</strong><small>GPS</small></span>
            <button type="button" onClick={() => { setNavigationBrowseIndex(null); if (mapRef.current) { (mapRef.current.getSource("step-preview") as GeoJSONSource)?.setData(lineFeature([])); mapRef.current.easeTo({ center: navigationLocation ?? origin ?? MAP_CENTER, zoom: 17, pitch: 48, duration: 450 }); } }}><LocateFixed size={17} />{navigationBrowseIndex === null ? "Recenter" : "Back to live"}</button>
          </div>
        </section>
      )}

      {previewedStep && !navigationActive && (
        <aside className="step-preview-card" aria-label="Route segment preview" onTouchStart={(event) => { previewTouchStartRef.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={(event) => {
          const start = previewTouchStartRef.current;
          const end = event.changedTouches[0]?.clientX;
          previewTouchStartRef.current = null;
          if (start === null || end === undefined || Math.abs(end - start) < 45) return;
          jumpPreview(end < start ? 1 : -1);
        }}>
          <button type="button" className="preview-jump" onClick={() => jumpPreview(-1)} disabled={previewedStepIndex === 0} aria-label="Previous segment"><ChevronLeft size={18} /></button>
          <span className="step-preview-icon"><StepIcon step={previewedStep.step} /></span>
          <span><small>{previewedStep.mode === "bike" ? "Ride segment" : "Walking segment"} · {formatDistance(previewedStep.step.distance_m)}</small><strong>{previewedStep.step.instruction}</strong></span>
          <span className="preview-position">{previewedStepIndex === null ? "" : `${previewedStepIndex + 1}/${navigationSteps.length}`}</span>
          <button type="button" className="preview-jump" onClick={() => jumpPreview(1)} disabled={previewedStepIndex === navigationSteps.length - 1} aria-label="Next segment"><ChevronRight size={18} /></button>
          <button type="button" className="preview-all" onClick={() => { setPreviewedStep(null); setPreviewedStepIndex(null); setShowTurns(true); if (mapRef.current) (mapRef.current.getSource("step-preview") as GeoJSONSource)?.setData(lineFeature([])); }}>All steps</button>
        </aside>
      )}

      {selectedMapStation && (
        <aside className={`station-popover ${selectedMapStation.kind}`} aria-label={`${selectedMapStation.name} BIXI station`}>
          <button type="button" className="station-popover-close" onClick={() => setSelectedMapStation(null)} aria-label="Close station details"><X size={17} /></button>
          <small>{selectedMapStation.kind === "pickup" ? "Nearby pickup" : "Nearby return"} · {formatDistance(selectedMapStation.walk_distance_m)} walk</small>
          <strong>{selectedMapStation.name}</strong>
          <div className="station-stats">
            <span><Bike size={15} /><b>{selectedMapStation.available_regular_bikes}</b><small>Regular</small></span>
            <span className="electric"><Zap size={14} fill="currentColor" /><b>{selectedMapStation.available_ebikes}</b><small>E-bikes</small></span>
            <span className="docks"><CircleParking size={15} /><b>{selectedMapStation.available_docks}</b><small>Docks</small></span>
          </div>
          <div className="station-popover-foot"><span>{timeAgo(selectedMapStation.availability_updated_at)}</span><button type="button" onClick={() => void requestRoutes(origin, destination, preference, { kind: selectedMapStation.kind, stationId: selectedMapStation.station_id })}>Use this {selectedMapStation.kind}</button></div>
        </aside>
      )}

      {selectedExplorerStation && viewMode === "explore" && (
        <aside className="station-popover" aria-label={`${selectedExplorerStation.name} BIXI station`}>
          <button type="button" className="station-popover-close" onClick={() => setSelectedExplorerStation(null)} aria-label="Close station details"><X size={17} /></button>
          <small>Live station availability</small>
          <strong>{selectedExplorerStation.name}</strong>
          <div className="station-stats">
            <span><Bike size={15} /><b>{selectedExplorerStation.available_regular_bikes}</b><small>Regular</small></span>
            <span className="electric"><Zap size={14} fill="currentColor" /><b>{selectedExplorerStation.available_ebikes}</b><small>E-bikes</small></span>
            <span className="docks"><CircleParking size={15} /><b>{selectedExplorerStation.available_docks}</b><small>Docks</small></span>
          </div>
          <div className="station-popover-foot"><span>{timeAgo(selectedExplorerStation.availability_updated_at)}</span><button type="button" onClick={() => { setOrigin(selectedExplorerStation.coordinates); setOriginLabel(selectedExplorerStation.name); setOriginSearchQuery(selectedExplorerStation.name); if (destination) void requestRoutes(selectedExplorerStation.coordinates, destination); setSelectedExplorerStation(null); setViewMode("plan"); }}>Plan from here</button></div>
        </aside>
      )}

      {mapPickMode && <div className="map-pick-banner"><MapPin size={18} /><span>Tap the map to set your {mapPickMode === "origin" ? "start" : "destination"}</span><button type="button" onClick={() => setMapPickMode(null)}><X size={18} /></button></div>}
      {showTurns && selectedRoute && <TurnList option={selectedRoute} onClose={() => { setShowTurns(false); setPreviewedStep(null); setPreviewedStepIndex(null); if (mapRef.current) (mapRef.current.getSource("step-preview") as GeoJSONSource)?.setData(lineFeature([])); }} onPreview={previewStep} onStart={startNavigation} />}
    </main>
  );
}

export default App;
