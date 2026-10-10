#!/usr/bin/env bash
# Runs the engine suite (pytest -m engine) in a Linux network namespace that has nothing but a
# loopback interface: the operating system itself, not only the Python level guard of the suite,
# guarantees that the real PR-Agent can reach nobody but the fakes. For CI (GitHub's Ubuntu runners
# have passwordless sudo); on a developer machine use `uv run pytest -m engine`.
#
#   scripts/run_engine_offline.sh [pytest arguments]
#
# The tiktoken cache is filled first, outside the namespace (the one step that needs the internet).
set -euo pipefail
cd "$(dirname "$0")/.."

uv run python scripts/prime_tiktoken_cache.py

# Inside the namespace the script proves that there is no way out, drops back to the calling user
# (the tests must not run as root) and runs the suite. `env PATH=...` because sudo replaces PATH.
sudo --preserve-env env "PATH=$PATH" "HOME=$HOME" ENGINE_USER="$(id -u):$(id -g)" \
  unshare --net -- bash -c '
    set -euo pipefail
    ip link set lo up
    if python3 -c "import socket; socket.create_connection((\"1.1.1.1\", 53), 3)" 2>/dev/null; then
      echo "the network namespace is not isolated" >&2
      exit 1
    fi
    exec setpriv --reuid="${ENGINE_USER%%:*}" --regid="${ENGINE_USER##*:}" --clear-groups \
      uv run --no-sync --offline pytest -m engine "$@"
  ' engine-offline "$@"
