#!/usr/bin/env bash

set -euo pipefail

source_config=${VALHALLA_SOURCE_CONFIG:-/custom_files/valhalla.json}
runtime_config=${VALHALLA_RUNTIME_CONFIG:-/tmp/valhalla.json}
service_bin=${VALHALLA_SERVICE_BIN:-valhalla_service}
port=${PORT:-80}
threads=${server_threads:-2}

case "$port" in
  ''|*[!0-9]*)
    echo "PORT must be a number, got: $port" >&2
    exit 1
    ;;
esac

if [[ ! -s "$source_config" ]]; then
  echo "Missing Valhalla config: $source_config" >&2
  exit 1
fi

python3 - "$source_config" "$runtime_config" "$port" <<'PY'
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
port = int(sys.argv[3])

with source.open(encoding="utf-8") as handle:
    config = json.load(handle)

config["httpd"]["service"]["listen"] = f"tcp://*:{port}"
destination.write_text(json.dumps(config), encoding="utf-8")
PY

exec "$service_bin" "$runtime_config" "$threads"
