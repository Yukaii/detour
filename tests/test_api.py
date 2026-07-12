import json

import pytest
from fastapi import HTTPException

import detour_api
from detour_api import TtlCache, bixi_routes, health, validate_route_request


def test_health() -> None:
    assert health() == {"status": "ok", "service": "detour-api"}


def test_ttl_cache_reuses_value() -> None:
    cache = TtlCache()
    calls = 0

    def create_value() -> dict[str, int]:
        nonlocal calls
        calls += 1
        return {"calls": calls}

    first, first_hit = cache.get_or_set(("key",), 60, create_value)
    second, second_hit = cache.get_or_set(("key",), 60, create_value)

    assert first == second == {"calls": 1}
    assert first_hit is False
    assert second_hit is True


def test_bixi_endpoint_marks_cached_response(monkeypatch) -> None:
    monkeypatch.setattr(detour_api, "route_cache", TtlCache())
    monkeypatch.setattr(detour_api, "bixi_response", lambda *args: {"options": [], "mode": "bixi"})

    request = {
        "origin": "45.50884,-73.58781",
        "destination": "45.53535,-73.62022",
        "bike_preference": "any",
        "max_walk_minutes": 15,
        "options": 1,
    }
    first = bixi_routes(**request)
    second = bixi_routes(**request)

    assert first.headers["X-Detour-Cache"] == "MISS"
    assert second.headers["X-Detour-Cache"] == "HIT"
    assert json.loads(second.body) == {"options": [], "mode": "bixi"}


def test_route_request_rejects_points_outside_montreal() -> None:
    with pytest.raises(HTTPException, match="outside the Montréal service area"):
        validate_route_request((43.6532, -79.3832), (45.53535, -73.62022))


def test_route_request_accepts_montreal_trip() -> None:
    validate_route_request((45.50884, -73.58781), (45.53535, -73.62022))


def test_route_request_rejects_excessive_distance() -> None:
    with pytest.raises(HTTPException, match="35 km maximum"):
        validate_route_request((45.40, -73.99), (45.71, -73.47))
