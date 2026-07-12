import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";
import maplibregl, { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import {
  Bike,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Crosshair,
  LocateFixed,
  MapPin,
  Navigation,
  RefreshCw,
  Route,
  Search,
  Timer,
  Undo2,
  X
} from "lucide-react";
import { fetchRoutes } from "./api";
import type { BikePreference, Coordinate, RouteLeg, RouteOption, RouteResponse, RouteStep } from "./types";

const DEFAULT_ORIGIN: Coordinate = [-73.58781, 45.50884];
const DEFAULT_DESTINATION: Coordinate = [-73.62022, 45.53535];
const MAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

const PLACES = [
  { name: "Jean-Talon Market", detail: "Little Italy", coordinate: [-73.6148, 45.5361] as Coordinate },
  { name: "Mile End", detail: "St-Viateur / Clark", coordinate: [-73.6012, 45.5232] as Coordinate },
  { name: "Parc Jarry", detail: "Saint-Laurent entrance", coordinate: [-73.625, 45.5325] as Coordinate },
  { name: "Place des Arts", detail: "Quartier des spectacles", coordinate: DEFAULT_ORIGIN }
];

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
  allCoordinates(option).forEach((coordinate) => bounds.extend(coordinate));
  map.fitBounds(bounds, { padding: { top: 150, right: 50, bottom: 310, left: 50 }, maxZoom: 15, duration: 700 });
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
        <button className="icon-button" onClick={onClose} aria-label="Close directions"><X size={20} /></button>
      </header>
      <div className="turn-scroll">
        {groups.map(({ label, icon: Icon, leg }) => (
          <section className="turn-group" key={label}>
            <h3><Icon size={17} />{label}<span>{formatDistance(leg.distance_m)}</span></h3>
            {leg.steps.map((step, index) => (
              <div className="turn-row" key={`${label}-${index}`}>
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

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const [origin, setOrigin] = useState<Coordinate>(DEFAULT_ORIGIN);
  const [destination, setDestination] = useState<Coordinate>(DEFAULT_DESTINATION);
  const [destinationName, setDestinationName] = useState("Jean-Talon Market");
  const [preference, setPreference] = useState<BikePreference>("any");
  const [routes, setRoutes] = useState<RouteResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapPickMode, setMapPickMode] = useState(false);
  const [showTurns, setShowTurns] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [destinationFocused, setDestinationFocused] = useState(false);
  const selectedRoute = routes?.options[selectedIndex];

  const requestRoutes = useCallback(async (nextOrigin = origin, nextDestination = destination) => {
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
      if ((requestError as Error).name !== "AbortError") setError((requestError as Error).message);
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, [destination, origin, preference]);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_STYLE,
      center: [-73.595, 45.521],
      zoom: 13,
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
      setDestinationName("Dropped pin");
      setMapPickMode(false);
      void requestRoutes(origin, nextDestination);
    };
    map.on("click", handleClick);
    return () => { map.off("click", handleClick); };
  }, [mapPickMode, origin, requestRoutes]);

  useEffect(() => {
    if (!mapReady || !selectedRoute || !mapRef.current) return;
    updateMapRoute(mapRef.current, selectedRoute, origin, destination);
  }, [destination, mapReady, origin, selectedRoute]);

  useEffect(() => { void requestRoutes(); }, []); // Initial reviewed route.

  const useCurrentLocation = () => {
    if (!navigator.geolocation) { setError("Location is not available on this device."); return; }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const nextOrigin: Coordinate = [coords.longitude, coords.latitude];
        setOrigin(nextOrigin);
        void requestRoutes(nextOrigin, destination);
      },
      () => setError("We could not access your location. Check browser permissions."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const matchingPlaces = useMemo(() => {
    const term = destinationName.trim().toLowerCase();
    if (!term) return PLACES;
    return PLACES.filter((place) => `${place.name} ${place.detail}`.toLowerCase().includes(term));
  }, [destinationName]);

  const selectPlace = (place: typeof PLACES[number]) => {
    setDestination(place.coordinate);
    setDestinationName(place.name);
    setDestinationFocused(false);
    void requestRoutes(origin, place.coordinate);
  };

  return (
    <main className={`app-shell ${mapPickMode ? "is-picking" : ""}`}>
      <div ref={mapContainer} className="map" aria-label="Détour route map" />

      <header className="top-bar">
        <div className="wordmark"><img src="/icon-1024.png" alt="" /><span>Detour</span><small>Montréal</small></div>
        <button className="icon-button coverage-button" aria-label="Center map" onClick={() => mapRef.current?.flyTo({ center: origin, zoom: 14 })}>
          <Crosshair size={19} />
        </button>
      </header>

      <section className="planner" aria-label="Route planner">
        <div className="planner-handle" />
        <div className="location-stack">
          <span className="location-rail"><CircleDot size={15} /><i /><MapPin size={16} /></span>
          <div className="location-fields">
            <button className="location-field origin-field" onClick={useCurrentLocation}>
              <span><small>START</small><strong>Current location</strong></span><LocateFixed size={18} />
            </button>
            <div className="destination-field">
              <Search size={18} />
              <input
                value={destinationName}
                onChange={(event) => setDestinationName(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onFocusCapture={() => setDestinationFocused(true)}
                onBlur={() => setDestinationFocused(false)}
                aria-label="Destination"
                placeholder="Where are you going?"
              />
              <button onClick={() => setMapPickMode(true)} aria-label="Choose destination on map"><MapPin size={18} /></button>
              {destinationFocused && matchingPlaces.length > 0 && (
                <div className="place-results">
                  {matchingPlaces.map((place) => (
                    <button key={place.name} onMouseDown={(event) => event.preventDefault()} onClick={() => selectPlace(place)}>
                      <MapPin size={16} /><span><strong>{place.name}</strong><small>{place.detail}</small></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="preference-row">
          <span>Bike</span>
          <div className="segmented" aria-label="Bike preference">
            {(["any", "ebike", "regular"] as BikePreference[]).map((value) => (
              <button key={value} className={preference === value ? "active" : ""} onClick={() => setPreference(value)}>
                {value === "any" ? "Any" : value === "ebike" ? "E-bike" : "Regular"}
              </button>
            ))}
          </div>
          <button className="refresh-button" onClick={() => void requestRoutes()} disabled={loading} aria-label="Refresh routes">
            <RefreshCw className={loading ? "spin" : ""} size={18} />
          </button>
        </div>

        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError(null)}><X size={17} /></button></div>}

        <div className="results-head">
          <span>{loading ? "Finding live BIXI routes..." : routes ? `${routes.options.length} live options` : "Plan a BIXI trip"}</span>
          {routes && <small>{timeAgo(routes.generated_at)}</small>}
        </div>

        <div className="route-options" aria-live="polite">
          {loading && !routes && [0, 1, 2].map((value) => <div className="route-skeleton" key={value} />)}
          {routes?.options.map((option, index) => (
            <button className={`route-option ${selectedIndex === index ? "selected" : ""}`} key={`${option.pickup.station_id}-${option.dropoff.station_id}`} onClick={() => setSelectedIndex(index)}>
              <span className="option-rank">{index + 1}</span>
              <span className="option-main">
                <strong>{option.estimated_total_minutes} min</strong>
                <small><Route size={14} /> {formatDistance(option.total_walk_m)} walk <i /> Comfort {option.comfort_score}</small>
              </span>
              <span className="availability">
                <span><Bike size={15} /><strong>{option.pickup.available_bikes}</strong></span>
                <span className="dock-icon">P</span><strong>{option.dropoff.available_docks}</strong>
              </span>
              <ChevronRight size={18} />
            </button>
          ))}
        </div>

        {selectedRoute && (
          <button className="mobile-directions-button" onClick={() => setShowTurns(true)}>
            <Navigation size={17} /><span>View directions</span><strong>{selectedRoute.estimated_total_minutes} min</strong><ChevronRight size={17} />
          </button>
        )}

        {selectedRoute && (
          <div className="station-strip">
            <div><span className="station-dot pickup-dot" /><span><small>Pick up · {timeAgo(selectedRoute.pickup.availability_updated_at)}</small><strong>{selectedRoute.pickup.name}</strong><em>{selectedRoute.pickup.available_regular_bikes} regular · {selectedRoute.pickup.available_ebikes} e-bikes</em></span></div>
            <div><span className="station-dot dropoff-dot" /><span><small>Return · {timeAgo(selectedRoute.dropoff.availability_updated_at)}</small><strong>{selectedRoute.dropoff.name}</strong><em>{selectedRoute.dropoff.available_docks} open docks</em></span></div>
            <button className="directions-button" onClick={() => setShowTurns(true)}><Navigation size={18} /><span>Directions</span><ChevronDown size={17} /></button>
          </div>
        )}
      </section>

      {mapPickMode && <div className="map-pick-banner"><MapPin size={18} /><span>Tap the map to set your destination</span><button onClick={() => setMapPickMode(false)}><X size={18} /></button></div>}
      {showTurns && selectedRoute && <TurnList option={selectedRoute} onClose={() => setShowTurns(false)} />}
    </main>
  );
}

export default App;
