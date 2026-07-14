from typing import Any

import pytest

from valhalla_router import ValhallaClient, decode_polyline, maneuver_name


def encode_polyline(points: list[tuple[float, float]], precision: int = 6) -> str:
    previous_latitude = previous_longitude = 0
    encoded: list[str] = []
    factor = 10**precision
    for latitude, longitude in points:
        latitude_value = round(latitude * factor)
        longitude_value = round(longitude * factor)
        for delta in (latitude_value - previous_latitude, longitude_value - previous_longitude):
            value = ~(delta << 1) if delta < 0 else delta << 1
            while value >= 0x20:
                encoded.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            encoded.append(chr(value + 63))
        previous_latitude = latitude_value
        previous_longitude = longitude_value
    return "".join(encoded)


def test_decode_valhalla_polyline_uses_geojson_coordinate_order() -> None:
    encoded = encode_polyline([(45.501, -73.601), (45.502, -73.599)])

    assert decode_polyline(encoded) == [[-73.601, 45.501], [-73.599, 45.502]]


def test_matrix_parses_reachable_pairs(monkeypatch: pytest.MonkeyPatch) -> None:
    client = ValhallaClient("http://valhalla:8002")
    captured: dict[str, Any] = {}

    def fake_post(action: str, payload: dict[str, Any]) -> dict[str, Any]:
        captured.update(action=action, payload=payload)
        return {
            "sources_to_targets": [
                [
                    {"from_index": 0, "to_index": 0, "time": 120, "distance": 0.7},
                    {"from_index": 0, "to_index": 1, "time": None, "distance": None},
                ]
            ]
        }

    monkeypatch.setattr(client, "_post", fake_post)
    costs = client.matrix([(45.5, -73.6)], [(45.51, -73.61), (45.52, -73.62)])

    assert captured["action"] == "sources_to_targets"
    assert captured["payload"]["costing"] == "bicycle"
    assert captured["payload"]["costing_options"]["bicycle"]["gate_penalty"] == 600
    assert len(costs) == 1
    assert costs[0].duration_seconds == 120
    assert costs[0].distance_m == pytest.approx(700)


def test_route_converts_shape_and_maneuvers(monkeypatch: pytest.MonkeyPatch) -> None:
    client = ValhallaClient("http://valhalla:8002")
    shape = encode_polyline([(45.5, -73.6), (45.501, -73.6), (45.501, -73.599)])
    monkeypatch.setattr(
        client,
        "_post",
        lambda action, payload: {
            "trip": {
                "summary": {"length": 0.22, "time": 62},
                "legs": [
                    {
                        "shape": shape,
                        "maneuvers": [
                            {
                                "type": 1,
                                "instruction": "Bike north on Rue Test.",
                                "street_names": ["Rue Test"],
                                "length": 0.1,
                                "begin_shape_index": 0,
                            },
                            {
                                "type": 10,
                                "instruction": "Turn right onto Avenue Test.",
                                "street_names": ["Avenue Test"],
                                "length": 0.12,
                                "begin_shape_index": 1,
                            },
                            {"type": 4, "instruction": "You have arrived.", "length": 0, "begin_shape_index": 2},
                        ],
                    }
                ],
            }
        },
    )

    route = client.route((45.5, -73.6), (45.501, -73.599))

    assert route.distance_m == 220
    assert route.duration_seconds == 62
    assert route.coordinates[-1] == [-73.599, 45.501]
    assert route.steps[1]["maneuver"] == "right"
    assert route.steps[1]["coordinate"] == [-73.6, 45.501]
    assert route.steps[-1]["maneuver"] == "arrive"
    assert route.sample_streets == ["Rue Test", "Avenue Test"]


def test_maneuver_name_handles_unknown_values() -> None:
    assert maneuver_name(None) == "continue"
    assert maneuver_name(15) == "left"
