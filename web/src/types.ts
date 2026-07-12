export type Coordinate = [number, number];
export type BikePreference = "any" | "ebike" | "regular";

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

export interface RouteOption {
  estimated_total_minutes: number;
  total_walk_m: number;
  comfort_score: number;
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
  origin: { coordinates: Coordinate };
  destination: { coordinates: Coordinate };
  bike_preference: BikePreference;
  max_walk_minutes: number;
  options: RouteOption[];
}
