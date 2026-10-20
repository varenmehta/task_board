#!/bin/sh
# Cloud volumes are mounted root-owned; fix ownership, then drop privileges.
set -e
mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR"
exec su-exec node "$@"
