#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# Smoke test of the app image. Usage: docker/smoke/app.sh <image>   (default: code-reviewer-app:local)
#
# Starts the image the way a deployment does (unprivileged user, a fresh named volume on /data, no
# other configuration), waits until the start page answers and the container reports healthy, and
# checks what a unit test cannot: the standalone server runs, the process is not root, the database
# was created and migrated in the volume, and the image holds no secrets or test files.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=docker/smoke/lib.sh
source "$here/lib.sh"

image=${1:-code-reviewer-app:local}
readonly WAIT_SECONDS=${SMOKE_WAIT_SECONDS:-90}
suffix="$$-$RANDOM"
container="cr-smoke-app-$suffix"
volume="cr-smoke-app-data-$suffix"

require_image "$image"
CLEANUP_CONTAINERS+=("$container")
CLEANUP_VOLUMES+=("$volume")

# CR-17-T07
step "the image sets a numeric non-root user"
assert_image_user_is_numeric_non_root "$image"

# #118-T03
step "the image ships the license files and carries the license label"
assert_image_ships_license_files "$image"

# CR-17-T09
step "the image holds no environment files, git data, keys or secrets"
assert_image_has_no_secrets "$image" "/srv/app /data /home /root /tmp"
leftovers=$(in_image "$image" find /srv/app -path /srv/app/node_modules -prune -o \
  \( -name '*.test.*' -o -name '*.e2e.ts' -o -name 'src' -o -name 'e2e' -o -name 'test-support' \) -print)
[ -z "$leftovers" ] || fail "tests or sources are inside the image:
$leftovers"

# CR-17-T08: a fresh named volume inherits the owner of /data from the image, so the unprivileged
# user can create the database without any chown or root step.
# Only the master key, the public address and the runner token are required (the production server
# refuses to start without them); these are dummies that point nowhere. No GITHUB_ variable is set:
# the image must start without any. Nothing in this script talks to GitHub.
step "starting the container with a fresh volume on /data"
docker volume create "$volume" >/dev/null
docker run --detach --name "$container" \
  --publish 127.0.0.1::3000 \
  --volume "$volume:/data" \
  --env APP_SECRET=smoke-test-secret-0123456789-0123456789-abcdef \
  --env BETTER_AUTH_URL=http://localhost:3000 \
  --env RUNNER_TOKEN=smoke-runner-token-0123456789-0123456789-abcdef \
  --health-interval 2s \
  "$image" >/dev/null
port=$(docker port "$container" 3000/tcp | head -n 1 | sed 's/.*://')
[ -n "$port" ] || fail "no host port is mapped to port 3000"

# CR-17-T04
step "waiting for the start page on port $port"
deadline=$((SECONDS + WAIT_SECONDS))
until body=$(curl --silent --fail --location --max-time 3 "http://127.0.0.1:$port/" 2>/dev/null); do
  state=$(docker inspect --format '{{.State.Status}}' "$container")
  if [ "$state" != "running" ]; then
    docker logs "$container" >&2 || true
    fail "the container stopped (state: $state) before the start page answered"
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    docker logs "$container" >&2 || true
    fail "the start page did not answer within ${WAIT_SECONDS}s"
  fi
  sleep 1
done
grep -qi '<html' <<<"$body" || fail "the start page did not return HTML"

# #97-SU-01, #97-SU-03: a fresh instance prints one setup code and gates everything but the health
# check. The start page shows the code form (and not the code), the API and the webhooks answer 503
# setup_required, the health route reads the database.
step "a fresh instance prints one setup code, shows the setup and gates the rest"
logs=$(docker logs "$container" 2>&1)
code=$(setup_code_from_log "$logs") || exit 1
start_page=$(curl --silent --max-time 5 "http://127.0.0.1:$port/")
grep -q 'Set up Code Reviewer' <<<"$start_page" || fail "the start page does not show the setup"
grep -qF "$code" <<<"$start_page" && fail "the setup code is in the start page"
for path in /api/projects /api/webhooks/github-app /api/runners/v1/claim; do
  answer=$(curl --silent --max-time 5 --write-out ' %{http_code}' --request POST "http://127.0.0.1:$port$path")
  [ "$answer" = '{"error":"setup_required"} 503' ] || fail "POST $path did not answer 503 setup_required (got: $answer)"
done
health=$(curl --silent --fail --max-time 5 "http://127.0.0.1:$port/api/health") ||
  fail "GET /api/health failed"
[ "$health" = '{"status":"ok"}' ] || fail "unexpected health answer: $health"

# #97-SU-11, #97-SU-14: the setup is finished through the API; afterwards it is gone and the access
# guard of the built server sends a visitor without a session to the login page.
step "the setup can be finished, and afterwards the start page is guarded"
complete_setup "http://127.0.0.1:$port" "$code"

step "waiting for the container to report healthy"
until [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" = "healthy" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    docker logs "$container" >&2 || true
    fail "the container did not become healthy within ${WAIT_SECONDS}s"
  fi
  sleep 1
done

# CR-17-T04: the standalone output is what runs (started by "node server.js", which the Next.js
# build generates only with output "standalone"), not the Next.js CLI.
step "the standalone server is running"
[ "$(docker inspect --format '{{json .Config.Cmd}}' "$image")" = '["node","server.js"]' ] ||
  fail "the image does not start the standalone server (node server.js)"
docker exec "$container" grep -q '__NEXT_PRIVATE_STANDALONE_CONFIG' /srv/app/server.js ||
  fail "/srv/app/server.js is not the generated standalone server"

# CR-17-T07: the main process (PID 1), not just the image setting, runs unprivileged.
step "the main process runs as a non-root user"
uid=$(docker exec "$container" awk '/^Uid:/ { print $2 }' /proc/1/status)
[[ "$uid" =~ ^[0-9]+$ ]] && [ "$uid" != "0" ] || fail "the main process runs with uid '$uid'"
printf '    main process uid: %s\n' "$uid"

# CR-17-T08: created and migrated, no permission error in the log.
# Next.js writes its runtime cache (ISR, image optimization) below .next/cache; the unprivileged
# user must be able to create it.
step "the unprivileged user can write the Next.js cache directory"
docker exec "$container" sh -c 'touch /srv/app/.next/cache/smoke-write && rm /srv/app/.next/cache/smoke-write' ||
  fail "/srv/app/.next/cache is not writable for the unprivileged user"

step "the database was created and migrated in the volume"
docker exec "$container" test -f /data/app.db || fail "/data/app.db was not created"
owner=$(docker exec "$container" stat --format '%u' /data/app.db)
[ "$owner" = "$uid" ] || fail "/data/app.db is owned by uid $owner, expected $uid"
migrations=$(docker exec "$container" node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/data/app.db", { readOnly: true });
  console.log(db.prepare("select count(*) as n from kysely_migration").get().n);
')
[ "$migrations" -ge 1 ] || fail "no migration is recorded in the database"
# Captured first: with "grep -q" in a pipeline, docker logs could get SIGPIPE and hide a match.
logs=$(docker logs "$container" 2>&1)
if grep -Eq 'MIGRATION_FAILED|DATABASE_LOCKED|DATABASE_OPEN_FAILED|DATABASE_DIRECTORY_UNAVAILABLE|DATABASE_CONFIG_INVALID|EACCES|EPERM|SQLITE_CANTOPEN|SQLITE_READONLY' <<<"$logs"; then
  printf '%s\n' "$logs" >&2
  fail "the container log reports a database error"
fi
printf '    %s migration(s) recorded\n' "$migrations"

step "app image smoke test passed"
