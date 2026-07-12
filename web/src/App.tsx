import { useCallback, useEffect, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";
import maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import {
  Bike,
  ChevronDown,
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
  Undo2,
  X
} from "lucide-react";
import { fetchRoutes, reverseGeocode, searchPlaces } from "./api";
import type { BikePreference, Coordinate, PlaceResult, RouteLeg, RouteOption, RouteResponse, RouteStep } from "./types";

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
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }] };
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

function clearMapRoute(map: MapLibreMap): void {
  (map.getSource("walk-pickup") as GeoJSONSource)?.setData(lineFeature([]));
  (map.getSource("bike-route") as GeoJSONSource)?.setData(lineFeature([]));
  (map.getSource("walk-dropoff") as GeoJSONSource)?.setData(lineFeature([]));
  (map.getSource("route-points") as GeoJSONSource)?.setData({ type: "FeatureCollection", features: [] });
}

function updateMapRoute(map: MapLibreMap, option: RouteOption, origin: Coordinate, destination: Coordinate): void {
  (map.getSource("walk-pickup") as GeoJSONSource).setData(lineFeature(option.legs.walk_to_pickup.coordinates));
  (map.getSource("bike-route") as GeoJSONSource).setData(lineFeature(option.legs.bike.coordinates));
  (map.getSource("walk-dropoff") as GeoJSONSource).setData(lineFeature(option.legs.walk_to_destination.coordinates));
  (map.getSource("route-points") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: [
      pointFeature(origin, "origin").features[0],
      pointFeature(option.pickup.coordinates, "pickup").features[0],
      pointFeature(option.dropoff.coordinates, "dropoff").features[0],
      pointFeature(destination, "destination").features[0]
    ]
  });
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

function TurnList({ option, onClose }: { option: RouteOption; onClose: () => void }) {
  const groups: Array<{ label: string; icon: typeof Bike; leg: RouteLeg }> = [
    { label: "Walk to BIXI", icon: Route, leg: option.legs.walk_to_pickup },
    { label: "Ride", icon: Bike, leg: option.legs.bike },
    { label: "Walk to destination", icon: Route, leg: option.legs.walk_to_destination }
  ];
  return (
    <div className="turn-sheet" role="dialog" aria-label="Route directions">
      <header className="turn-header">
        <div><span>Directions</span><strong>{option.estimated_total_minutes} min total</strong></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close directions"><X size={20} /></button>
      </header>
      <div className="turn-scroll">
        {groups.map(({ label, icon: Icon, leg }) => (
          <section className="turn-group" key={label}>
            <h3><Icon size={17} />{label}<span>{formatDistance(leg.distance_m)}</span></h3>
            {leg.steps.map((step, index) => (
              <div className="turn-row" key={`${label}-${step.instruction}-${step.distance_m}-${index}`}>
                <span className="turn-icon"><StepIcon step={step} /></span>
                <span><strong>{step.instruction}</strong>{step.distance_m > 0 && <small>{formatDistance(step.distance_m)}</small>}</span>
              </div>
            ))}
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
  const [origin, setOrigin] = useState<Coordinate | null>(null);
  const [destination, setDestination] = useState<Coordinate | null>(null);
  const [destinationName, setDestinationName] = useState("");
  const [originLabel, setOriginLabel] = useState("Set start location");
  const [usingGps, setUsingGps] = useState(false);
  const [preference, setPreference] = useState<BikePreference>("any");
  const [routes, setRoutes] = useState<RouteResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapPickMode, setMapPickMode] = useState(false);
  const [showTurns, setShowTurns] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [destinationFocused, setDestinationFocused] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const selectedRoute = routes?.options[selectedIndex];

  const requestRoutes = useCallback(async (nextOrigin: Coordinate | null = origin, nextDestination: Coordinate | null = destination) => {
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
    try {
      const response = await fetchRoutes(nextOrigin, nextDestination, preference, controller.signal);
      setRoutes(response);
      setSelectedIndex(0);
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
    if (!map) return;
    const handleClick = (event: maplibregl.MapMouseEvent) => {
      if (!mapPickMode) return;
      const nextDestination: Coordinate = [event.lngLat.lng, event.lngLat.lat];
      setDestination(nextDestination);
      setDestinationName("Locating…");
      setSearchQuery("");
      setMapPickMode(false);
      void reverseGeocode(nextDestination).then((place) => {
        setDestinationName(place.name);
        if (!inCoverage(place)) {
          setRoutes(null);
          setError("That point is outside central Montréal coverage. Try Mile End, Plateau, or Jean-Talon.");
        }
      });
      if (origin) void requestRoutes(origin, nextDestination);
    };
    map.on("click", handleClick);
    return () => { map.off("click", handleClick); };
  }, [mapPickMode, origin, requestRoutes]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    if (!selectedRoute || !origin || !destination) {
      clearMapRoute(mapRef.current);
      return;
    }
    updateMapRoute(mapRef.current, selectedRoute, origin, destination);
  }, [destination, mapReady, origin, selectedRoute]);

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

  const useCurrentLocation = () => {
    if (!navigator.geolocation) { setError("Location is not available on this device."); return; }
    setUsingGps(true);
    setOriginLabel("Locating…");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const nextOrigin: Coordinate = [coords.longitude, coords.latitude];
        setOrigin(nextOrigin);
        setOriginLabel("Current location");
        setUsingGps(false);
        mapRef.current?.flyTo({ center: nextOrigin, zoom: 14 });
        void requestRoutes(nextOrigin, destination);
      },
      () => {
        setUsingGps(false);
        setOriginLabel("Set start location");
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

  const showResults = destinationFocused;
  const displayResults = searchQuery.trim().length < 2 ? SUGGESTED_PLACES : searchResults;

  return (
    <main className={`app-shell ${mapPickMode ? "is-picking" : ""}`}>
      <div ref={mapContainer} className="map" aria-label="Detour route map" />

      <header className="top-bar">
        <div className="mobile-brand"><Wordmark /></div>
        <button type="button" className="icon-button coverage-button" aria-label="Center map" onClick={() => mapRef.current?.flyTo({ center: origin ?? MAP_CENTER, zoom: origin ? 14 : 12.4 })}>
          <Crosshair size={19} />
        </button>
      </header>

      <section className="planner" aria-label="Route planner">
        <div className="planner-handle" />
        <div className="planner-brand"><Wordmark /></div>
        <div className="location-stack">
          <span className="location-rail"><CircleDot size={15} /><i /><MapPin size={16} /></span>
          <div className="location-fields">
            <button type="button" className="location-field origin-field" onClick={useCurrentLocation}>
              <span>
                <small>START</small>
                <strong className={!origin ? "is-placeholder" : undefined}>{originLabel}</strong>
              </span>
              {usingGps ? <Loader2 className="spin" size={18} /> : <LocateFixed size={18} />}
            </button>
            <div className="destination-field">
              <Search size={18} />
              <input
                value={destinationFocused ? searchQuery : destinationName}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  if (!destinationFocused) setDestinationFocused(true);
                }}
                onFocus={() => {
                  setDestinationFocused(true);
                  setSearchQuery(destinationName === "Locating…" ? "" : destinationName);
                }}
                onBlur={() => {
                  window.setTimeout(() => setDestinationFocused(false), 120);
                }}
                aria-label="Destination"
                placeholder="Where to?"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" onClick={() => setMapPickMode(true)} aria-label="Choose destination on map"><MapPin size={18} /></button>
              {showResults && (
                <div className="place-results">
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
                  <button type="button" className="place-map-pick" onMouseDown={(event) => event.preventDefault()} onClick={() => { setDestinationFocused(false); setMapPickMode(true); }}>
                    <MapPin size={16} /><span><strong>Pick on map</strong><small>Central Montréal pilot area</small></span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="preference-row">
          <span>Bike</span>
          <div className="segmented" aria-label="Bike preference">
            {(["any", "ebike", "regular"] as BikePreference[]).map((value) => (
              <button type="button" key={value} className={preference === value ? "active" : ""} onClick={() => setPreference(value)}>
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
                <span><Bike size={15} /><strong>{option.pickup.available_bikes}</strong></span>
                <span className="dock-icon" aria-label="Open docks"><CircleParking size={13} strokeWidth={2.4} /></span>
                <strong>{option.dropoff.available_docks}</strong>
              </span>
              <ChevronRight size={18} />
            </button>
          ))}
        </div>

        {selectedRoute && (
          <button type="button" className="mobile-directions-button" onClick={() => setShowTurns(true)}>
            <Navigation size={17} /><span>View directions</span><strong>{selectedRoute.estimated_total_minutes} min</strong><ChevronRight size={17} />
          </button>
        )}

        {selectedRoute && (
          <div className="station-strip">
            <div><span className="station-dot pickup-dot" /><span><small>Pick up · {timeAgo(selectedRoute.pickup.availability_updated_at)}</small><strong>{selectedRoute.pickup.name}</strong><em>{selectedRoute.pickup.available_regular_bikes} regular · {selectedRoute.pickup.available_ebikes} e-bikes</em></span></div>
            <div><span className="station-dot dropoff-dot" /><span><small>Return · {timeAgo(selectedRoute.dropoff.availability_updated_at)}</small><strong>{selectedRoute.dropoff.name}</strong><em>{selectedRoute.dropoff.available_docks} open docks</em></span></div>
            <button type="button" className="directions-button" onClick={() => setShowTurns(true)}><Navigation size={18} /><span>Directions</span><ChevronDown size={17} /></button>
          </div>
        )}
      </section>

      {mapPickMode && <div className="map-pick-banner"><MapPin size={18} /><span>Tap the map to set your destination</span><button type="button" onClick={() => setMapPickMode(false)}><X size={18} /></button></div>}
      {showTurns && selectedRoute && <TurnList option={selectedRoute} onClose={() => setShowTurns(false)} />}
    </main>
  );
}

export default App;
