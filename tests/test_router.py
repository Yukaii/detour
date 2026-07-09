import networkx as nx

from detour_router import graph_bbox_buffer_km, walking_station_candidates


def walk_graph_with_detour() -> nx.MultiDiGraph:
    graph = nx.MultiDiGraph()
    graph.add_node(1, x=-73.0, y=45.0)
    graph.add_node(2, x=-73.0, y=45.005)
    graph.add_node(3, x=-73.0, y=45.01)
    graph.add_edge(1, 2, length=600, shortest_cost=600)
    graph.add_edge(2, 3, length=600, shortest_cost=600)
    return graph


def test_walking_station_candidates_use_network_distance() -> None:
    station = {
        "station_id": "station-1",
        "name": "Test station",
        "point": (45.01, -73.0),
        "is_installed": True,
        "is_renting": True,
        "num_bikes_available": 8,
        "num_ebikes_available": 0,
        "available_regular_bikes": 8,
    }

    candidates = walking_station_candidates(
        walk_graph_with_detour(),
        [station],
        (45.0, -73.0),
        max_walk_m=900,
        kind="pickup",
        bike_preference="any",
        limit=3,
    )

    assert candidates == []


def test_bixi_graph_buffer_covers_station_search_radius() -> None:
    args = type("Args", (), {"bbox_buffer_km": 1.5, "max_walk_minutes": 15, "mode": "bixi"})()

    assert graph_bbox_buffer_km(args) == 2.41
