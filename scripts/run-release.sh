#!/bin/sh
# Starts a staged release with the Node.js binary it was built with.
set -e
cd "$(dirname "$0")/.."
exec "$(cat node-path.txt)" server.js
