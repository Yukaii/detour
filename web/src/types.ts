export type Coordinate = [number, number];
export type BikePreference = "any" | "ebike" | "regular";

export interface PlaceResult {
  id: string;
  name: string;
  detail: string;
  coordinate: Coordinate;
  in_coverage?: boolean;
}

export interface RouteStep {
  instruction: string;
  maneuver: string;
  street_name: string;
  distance_m: number;
  coordinate: Coordinate;
  edge_keys: number[];
}

export interface RouteLeg {
  distance_m: number;
  coordinates: Coordinate[];
  steps: RouteStep[];
  comfort_score?: number;
  infrastructure_breakdown?: Record<string, number>;
  sample_streets?: string[];
}

export interface PickupStation {
  station_id: string;
  name: string;
  coordinates: Coordinate;
  walk_distance_m: number;
  available_bikes: number;
  available_regular_bikes: number;
  available_ebikes: number;
  availability_updated_at?: string;
}

export interface DropoffStation {
  station_id: string;
  name: string;
  coordinates: Coordinate;
  walk_distance_m: number;
  available_docks: number;
  availability_updated_at?: string;
}

export interface NearbyStation extends PickupStation {
  available_docks: number;
  kind: "pickup" | "dropoff";
}

export interface BixiStation {
  station_id: string;
  name: string;
  coordinates: Coordinate;
  available_bikes: number;
  available_regular_bikes: number;
  available_ebikes: number;
  available_docks: number;
  is_renting: boolean;
  is_returning: boolean;
  availability_updated_at?: string;
}

export interface BixiStationsResponse {
  generated_at: string;
  stations: BixiStation[];
}

export interface RouteOption {
  estimated_total_minutes: number;
  total_walk_m: number;
  comfort_score: number | null;
  pickup: PickupStation;
  dropoff: DropoffStation;
  legs: {
    walk_to_pickup: RouteLeg;
    bike: RouteLeg;
    walk_to_destination: RouteLeg;
  };
}

export interface RouteResponse {
  generated_at: string;
  mode: "bixi";
  routing_provider: "osm" | "valhalla";
  origin: { coordinates: Coordinate };
  destination: { coordinates: Coordinate };
  bike_preference: BikePreference;
  max_walk_minutes: number;
  options: RouteOption[];
  nearby_stations: NearbyStation[];
  traffic_restrictions: {
    status: "disabled" | "active" | "stale" | "unavailable";
    version: string;
    fetched_at: string;
    feed_timestamp: string | null;
    active_restriction_count: number;
    matched_edge_count: number;
    route_restriction_ids: string[];
    detail: string | null;
  };
}
