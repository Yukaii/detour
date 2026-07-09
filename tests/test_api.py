from detour_api import health


def test_health() -> None:
    assert health() == {"status": "ok", "service": "detour-api"}
