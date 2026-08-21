#!/usr/bin/env bash

set -euo pipefail

app=${1:-detour-montreal-valhalla}
artifact_root=${2:-.vercel-artifacts}
bundle_path="$artifact_root/valhalla-runtime.tar.gz"
download_dir=$(mktemp -d)

cleanup() {
  if [[ -n "$download_dir" && -d "$download_dir" ]]; then
    rm -rf -- "$download_dir"
  fi
}

trap cleanup EXIT

required_files=(
  valhalla.json
  default_speeds.json
  valhalla_tiles.tar
  admins.sqlite
  timezones.sqlite
)

mkdir -p "$artifact_root"

for filename in "${required_files[@]}"; do
  echo "Exporting /custom_files/$filename from $app"
  flyctl sftp get \
    "/custom_files/$filename" \
    "$download_dir/$filename" \
    --app "$app"
done

for filename in "${required_files[@]}"; do
  if [[ ! -s "$download_dir/$filename" ]]; then
    echo "Exported file is missing or empty: $download_dir/$filename" >&2
    exit 1
  fi
done

tar -czf "$bundle_path" -C "$download_dir" "${required_files[@]}"
shasum -a 256 "$bundle_path" > "$bundle_path.sha256"

echo "Created $bundle_path"
cat "$bundle_path.sha256"
