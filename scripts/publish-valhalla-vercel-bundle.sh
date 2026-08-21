#!/usr/bin/env bash

set -euo pipefail

repository=${1:-Yukaii/detour}
release_tag=${2:-valhalla-runtime-20260712}
artifact_root=${3:-.vercel-artifacts}
bundle_path="$artifact_root/valhalla-runtime.tar.gz"
checksum_path="$bundle_path.sha256"

if [[ ! -s "$bundle_path" || ! -s "$checksum_path" ]]; then
  echo "Missing bundle or checksum. Run scripts/export-valhalla-vercel-bundle.sh first." >&2
  exit 1
fi

shasum -a 256 -c "$checksum_path"

if gh release view "$release_tag" --repo "$repository" >/dev/null 2>&1; then
  echo "Release already exists; refusing to overwrite it: $repository@$release_tag" >&2
  exit 1
fi

gh release create "$release_tag" \
  "$bundle_path" \
  "$checksum_path" \
  --repo "$repository" \
  --prerelease \
  --title "Valhalla runtime data 20260712" \
  --notes "Runtime-only Québec Valhalla tiles for the Détour Montréal service. Derived from OpenStreetMap data and distributed under ODbL; © OpenStreetMap contributors."
