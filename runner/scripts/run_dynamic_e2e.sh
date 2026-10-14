#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# The privileged Dynamic e2e lane (#253, #201-T01): the journey of a pull request through the real app,
# the real Dynamic runner as root and the real pinned OpenCode as its engine user, against the loopback
# fakes. It needs root, nft and a Linux kernel with network namespaces, so it runs in CI (GitHub's Ubuntu
# runners have passwordless sudo) or on a machine where you can sudo. It never skips: what is missing is
# named (app/e2e/helpers/dynamic-preflight.ts) and the run fails.
#
#   scripts/run_dynamic_e2e.sh [playwright arguments, for example --grep @smoke]
#
# Two steps:
#   1. as you, with the internet: the pinned OpenCode and ripgrep (fetch_opencode.py and fetch_ripgrep.py
#      accept only the pinned bytes) and the one production build of the app (`next build`; set
#      E2E_REUSE_BUILD=1 to use the build that is there);
#   2. as root, in `unshare --net --mount --pid --fork --mount-proc`: scripts/dynamic_e2e_namespace.sh. The
#      namespaces hold the lane: loopback is the only network (and a network guard counts and rejects every
#      attempt to leave it), the mounts and the engine user exist only inside, and when the lane ends every
#      process in it ends with it.
# The ports are private: the app listens on E2E_PIPELINE_PORT (default E2E_PORT + 1; E2E_PORT defaults to
# 3517 here), the fakes take random ones. Never 3000 or 3100.
set -euo pipefail
cd "$(dirname "$0")/.."
RUNNER_DIR="$PWD"
APP_DIR="$(cd ../app && pwd)"

for tool in sudo unshare setpriv ip nft; do
  command -v "$tool" >/dev/null || [ -x "/usr/sbin/$tool" ] \
    || { echo "The Dynamic e2e lane needs $tool and it is not installed." >&2; exit 1; }
done
sudo -n true 2>/dev/null \
  || { echo "The Dynamic e2e lane needs sudo without a password (root for the supervisor, nft and the engine user)." >&2; exit 1; }

# The staging directory is ours; the root part mounts a tmpfs on `lane` (inside its mount namespace
# only), so what it installs there never reaches the host and this directory stays empty.
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
mkdir "$STAGING/lane"

# Step 1: the pinned tools and the one build.
OPENCODE_BIN="$(uv run python scripts/fetch_opencode.py)"
RIPGREP_BIN="$(uv run python scripts/fetch_ripgrep.py --dest "$STAGING/ripgrep")"
if [ "${E2E_REUSE_BUILD:-}" != "1" ]; then
  (cd "$APP_DIR" && NEXT_TELEMETRY_DISABLED=1 pnpm build)
fi

export E2E_PORT="${E2E_PORT:-3517}"
case "$E2E_PORT:${E2E_PIPELINE_PORT:-}" in
  3000:* | 3100:* | *:3000 | *:3100 | 2999:* | 3099:*)
    echo "The Dynamic e2e lane must not use the ports 3000 or 3100 (E2E_PORT=$E2E_PORT): other work runs there." >&2
    exit 1 ;;
esac

# Step 2: root, in the lane's namespaces. `env PATH=...` because sudo replaces PATH.
set +e
sudo --preserve-env env "PATH=$PATH:/usr/sbin:/sbin" "HOME=$HOME" \
  "LANE_OPENCODE_BIN=$OPENCODE_BIN" "LANE_RIPGREP_BIN=$RIPGREP_BIN" \
  "LANE_APP_DIR=$APP_DIR" "LANE_RUNNER_DIR=$RUNNER_DIR" "LANE_STAGE=$STAGING/lane" "E2E_PORT=$E2E_PORT" \
  unshare --net --mount --pid --fork --mount-proc -- \
  bash "$RUNNER_DIR/scripts/dynamic_e2e_namespace.sh" "$@"
status=$?
set -e
exit "$status"
