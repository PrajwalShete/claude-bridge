#!/bin/zsh
# Builds the plugin's two Swift programs as universal binaries (Apple silicon and Intel) into
# plugin/connector/prebuilt/, each with the SHA-256 of the source it was built from. The plugin
# installs a prebuilt binary whose stamp matches its source, so no computer needs Xcode; it builds
# from source only where they differ (a development copy).
#   scripts/build-binaries.sh          build both
#   scripts/build-binaries.sh --check  fail if a prebuilt binary is older than its source
set -euo pipefail
cd "$(dirname "$0")/../plugin/connector"
mkdir -p prebuilt
stale=0
for name in connector device; do
  want=$(shasum -a 256 "$name.swift" | cut -d' ' -f1)
  have=$(cat "prebuilt/claude-bridge-$name.sha256" 2>/dev/null || true)
  if [[ "${1:-}" == "--check" ]]; then
    if [[ "$want" != "$have" ]]; then echo "stale: prebuilt/claude-bridge-$name (run scripts/build-binaries.sh)"; stale=1; fi
    continue
  fi
  tmp=$(mktemp -d)
  for arch in arm64 x86_64; do
    swiftc -O -swift-version 5 -target "$arch-apple-macos12" -o "$tmp/$arch" "$name.swift"
  done
  lipo -create -output "prebuilt/claude-bridge-$name" "$tmp/arm64" "$tmp/x86_64"
  codesign --force --sign - "prebuilt/claude-bridge-$name"
  echo "$want" > "prebuilt/claude-bridge-$name.sha256"
  rm -rf "$tmp"
  echo "built prebuilt/claude-bridge-$name ($(lipo -archs "prebuilt/claude-bridge-$name"))"
done
exit $stale
