#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec node mcp/server.mjs
