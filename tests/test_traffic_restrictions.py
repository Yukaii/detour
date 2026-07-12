import json
from datetime import UTC, datetime, timedelta

import networkx as nx

from detour_router import route_between
from traffic_restrictions import (
    EdgeRestriction,
    RestrictionSnapshot,
    TrafficRestrictionProvider,
    TrafficRestriction,
    match_restrictions,
    parse_cifs,
    restriction_weight,
)


NOW = datetime(2026, 7, 12, 16, tzinfo=UTC)


def routing_graph() -> nx.MultiDiGraph:
    graph = nx.MultiDiGraph()
    graph.add_node(1, x=-73.6000, y=45.5200)
    graph.add_node(2, x=-73.5990, y=45.5200)
    graph.add_node(3, x=-73.5980, y=45.5200)
    graph.add_node(4, x=-73.5990, y=45.5210)
    graph.add_edge(1, 2, key=0, length=100, bike_path_first_cost=100)
    graph.add_edge(2, 3, key=0, length=100, bike_path_first_cost=100)
    graph.add_edge(1, 4, key=0, length=140, bike_path_first_cost=140)
    graph.add_edge(4, 3, key=0, length=140, bike_path_first_cost=140)
    return graph


def test_parse_cifs_filters_inactive_events_and_classifies_closure() -> None:
    payload = {
        "timestamp": NOW.isoformat(),
        "events": [
            {
                "id": "active",
                "starttime": (NOW - timedelta(hours=1)).isoformat(),
                "endtime": (NOW + timedelta(hours=1)).isoformat(),
                "type": "ROAD_CLOSED",
                "description": "Fermeture complète",
                "location": {"polyline": [[-73.6000, 45.5200], [-73.5990, 45.5200]]},
            },
            {
                "id": "expired",
                "endtime": (NOW - timedelta(minutes=1)).isoformat(),
                "location": {"polyline": [[-73.5990, 45.5200], [-73.5980, 45.5200]]},
            },
        ],
    }

    restrictions, timestamp = parse_cifs(payload, NOW)

    assert timestamp == NOW
    assert [item.id for item in restrictions] == ["active"]
    assert restrictions[0].severity == "closed"


def test_match_restrictions_maps_polyline_to_nearby_edge() -> None:
    restriction = TrafficRestriction(
        id="closure-1",
        start_at=None,
        end_at=None,
        kind="ROAD_CLOSED",
        subtype="",
        description="",
        direction="BOTH_DIRECTIONS",
        coordinates=((-73.6000, 45.5200), (-73.5990, 45.5200)),
        severity="closed",
    )

    matches = match_restrictions(routing_graph(), (restriction,), tolerance_m=8)

    assert (1, 2, 0) in matches
    assert matches[(1, 2, 0)][0].penalty is None


def test_confirmed_closure_is_excluded_from_route() -> None:
    graph = routing_graph()
    snapshot = RestrictionSnapshot(
        version="v1",
        status="active",
        fetched_at=NOW,
        affected_edges={(1, 2, 0): (EdgeRestriction("closure-1", "closed", None),)},
    )

    route = route_between(
        graph,
        (45.5200, -73.6000),
        (45.5200, -73.5980),
        restriction_weight("bike_path_first_cost", snapshot),
    )

    assert route == [1, 4, 3]


def test_caution_penalty_can_select_safer_alternative() -> None:
    graph = routing_graph()
    snapshot = RestrictionSnapshot(
        version="v2",
        status="active",
        fetched_at=NOW,
        affected_edges={(1, 2, 0): (EdgeRestriction("works-1", "caution", 2.0),)},
    )

    route = route_between(
        graph,
        (45.5200, -73.6000),
        (45.5200, -73.5980),
        restriction_weight("bike_path_first_cost", snapshot),
    )

    assert route == [1, 4, 3]


def test_disabled_snapshot_metadata_is_explicit() -> None:
    snapshot = RestrictionSnapshot("disabled", "disabled", NOW, detail="Not enabled")

    assert snapshot.payload()["status"] == "disabled"
    assert snapshot.payload()["active_restriction_count"] == 0
    assert snapshot.payload()["detail"] == "Not enabled"


def test_provider_fails_open_when_upstream_is_unavailable(monkeypatch) -> None:
    def unavailable(*args, **kwargs):
        raise TimeoutError("feed timeout")

    monkeypatch.setattr("urllib.request.urlopen", unavailable)
    provider = TrafficRestrictionProvider(True, "https://example.test/cifs", ttl_seconds=60)

    snapshot = provider.snapshot(routing_graph())

    assert snapshot.status == "unavailable"
    assert snapshot.affected_edges == {}
    assert "TimeoutError" in (snapshot.detail or "")


def test_provider_does_not_apply_stale_feed(monkeypatch) -> None:
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return json.dumps({"timestamp": "2020-01-01T00:00:00Z", "events": []}).encode()

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: Response())
    provider = TrafficRestrictionProvider(True, "https://example.test/cifs", stale_seconds=300)

    snapshot = provider.snapshot(routing_graph())

    assert snapshot.status == "stale"
    assert snapshot.affected_edges == {}
