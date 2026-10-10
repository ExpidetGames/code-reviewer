#!/usr/bin/env bash
# Self-test of the key scan used by the image smoke tests (docker/smoke/lib.sh). Needs no Docker.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
assert_key_scan_works
echo "key scan self-test passed"
