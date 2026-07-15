#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export PATH="${PATH}:$(go env GOPATH)/bin"

command -v gomobile >/dev/null 2>&1 || {
  echo "gomobile is required. Install with: go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init" >&2
  exit 1
}

export GOCACHE="${GOCACHE:-$(pwd)/../../../.go-cache}"
export GOMODCACHE="${GOMODCACHE:-$(pwd)/../../../.go-mod-cache}"

go mod tidy
mkdir -p ../../app/libs
gomobile bind -target=android -androidapi 23 -o ../../app/libs/utlsws.aar .
