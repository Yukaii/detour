import json

import detour_api
from detour_api import TtlCache, bixi_routes, health


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
