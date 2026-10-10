#!/usr/bin/env bash
# Smoke test of the Docker Compose stack (compose.yml).
# Usage: docker/smoke/compose.sh [<app image> [<runner image>]]
#   (defaults: code-reviewer-app:local and code-reviewer-runner:local; build them first, for example
#   with `make test-compose`). Nothing is pulled or pushed.
#
# Works in a fresh temporary directory with a copy of compose.yml, a project name of its own and
# dummy settings (the keys are generated here and never leave this machine; nothing in this script
# signs in), so it never touches a real `.env`, a real stack or a real volume. It proves what a
# unit test on the files cannot: the settings are validated before a container exists, the runner
# waits for a healthy app, the stack comes up, the database survives `down` and `up`, and a killed
# app container comes back by itself. Containers, networks and volumes are removed on exit, also
# after a failure.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$here/../.." && pwd)
# shellcheck source=docker/smoke/lib.sh
source "$here/lib.sh"

app_image=${1:-code-reviewer-app:local}
runner_image=${2:-code-reviewer-runner:local}
readonly WAIT_SECONDS=${SMOKE_WAIT_SECONDS:-120}
project="cr-smoke-compose-$$-$RANDOM"
workdir=$(mktemp -d)

extra_cleanup() {
  if [ -d "$workdir" ]; then
    docker compose --project-name "$project" --project-directory "$workdir" \
      --file "$workdir/compose.yml" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true
    rm -rf "$workdir"
  fi
}

require_image "$app_image"
require_image "$runner_image"
command -v openssl >/dev/null || fail "openssl is required (it generates the dummy GitHub App key)"
cp "$repo_root/compose.yml" "$workdir/compose.yml"

# The settings of the stack: dummies that point nowhere. Everything the compose file reads is set
# or unset here, so values from the caller's shell cannot leak in.
unset APP_BIND_ADDRESS ALLOWED_GITHUB_ORG DATABASE_BUSY_TIMEOUT_MS LLM_PROVIDER LLM_API_KEY
export APP_IMAGE=$app_image
export RUNNER_IMAGE=$runner_image
export APP_PORT=0 # Docker picks a free port on the host
export BETTER_AUTH_URL=http://localhost:3000
export BETTER_AUTH_SECRET=smoke-test-secret-0123456789-0123456789-abcdef
export GITHUB_OAUTH_CLIENT_ID=smoke-client-id
export GITHUB_OAUTH_CLIENT_SECRET=smoke-client-secret
export ALLOWED_GITHUB_LOGINS=smoke-user
export GITHUB_APP_ID=1
export GITHUB_APP_SLUG=smoke-app
export GITHUB_APP_WEBHOOK_SECRET=smoke-webhook-secret
GITHUB_APP_PRIVATE_KEY=$(openssl genrsa 2048 2>/dev/null)
export GITHUB_APP_PRIVATE_KEY
export RUNNER_TOKEN=smoke-runner-token-0123456789-0123456789-abcdef

dc() {
  docker compose --project-name "$project" --project-directory "$workdir" \
    --file "$workdir/compose.yml" "$@"
}

fail_with_logs() {
  dc logs --no-color >&2 || true
  fail "$*"
}

# Prints the id of a service's container, or nothing when it does not exist.
container_of() { dc ps --all --quiet "$1" | head -n 1; }
state_of() {
  local id
  id=$(container_of "$1")
  [ -n "$id" ] && docker inspect --format '{{.State.Status}}' "$id" || true
}
health_of() {
  local id
  id=$(container_of "$1")
  [ -n "$id" ] && docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" || true
}

# Waits until the command succeeds. Usage: wait_until <what> <seconds> <command...>
wait_until() {
  local what=$1 seconds=$2 deadline
  shift 2
  deadline=$((SECONDS + seconds))
  until "$@"; do
    [ "$SECONDS" -lt "$deadline" ] || fail_with_logs "timed out after ${seconds}s waiting for: $what"
    sleep 1
  done
}

app_is_healthy() { [ "$(health_of app)" = "healthy" ]; }
runner_is_running() { [ "$(state_of runner)" = "running" ]; }
app_restarted_and_healthy() {
  [ "$(docker inspect --format '{{.State.StartedAt}}' "$(container_of app)")" != "$1" ] && app_is_healthy
}
runner_reports_connection() {
  local log
  log=$(dc logs --no-color runner 2>&1)
  grep -q 'connected to http://app:3000' <<<"$log"
}
# True when the newest status line of the runner log says it is connected (not "cannot reach").
runner_reports_connection_last() {
  local last
  last=$(dc logs --no-color runner 2>&1 | grep -E 'connected to |cannot reach ' | tail -n 1)
  [[ "$last" == *"connected to http://app:3000" ]]
}
host_port() { dc port app 3000 | head -n 1 | sed 's/.*://'; }

# CR-37-T01
step "the compose file validates with a complete configuration and defines exactly app and runner"
dc config --quiet || fail "docker compose config failed with a complete configuration"
services=$(dc config --services | sort | tr '\n' ' ')
[ "$services" = "app runner " ] || fail "expected the services 'app runner', got '$services'"

# CR-37-T08: a missing required setting stops `up` with a message naming it, before any container.
step "a missing runner token stops the start before a container is created"
if message=$(env -u RUNNER_TOKEN docker compose --project-name "$project" --project-directory "$workdir" \
  --file "$workdir/compose.yml" up --detach 2>&1); then
  fail "docker compose up succeeded without RUNNER_TOKEN"
fi
grep -q 'RUNNER_TOKEN is required' <<<"$message" || fail "the message does not name RUNNER_TOKEN: $message"
[ -z "$(dc ps --all --quiet)" ] || fail "containers exist although RUNNER_TOKEN was missing"
printf '    refused with: %s\n' "$(grep -m1 'RUNNER_TOKEN' <<<"$message")"

# CR-37-T05: the runner does not start while the app never becomes healthy.
step "the runner does not start while the app is not healthy"
cat >"$workdir/never-healthy.yml" <<'YAML'
services:
  app:
    healthcheck:
      test: ["CMD", "false"]
      interval: 1s
      timeout: 2s
      retries: 2
      start_period: 0s
YAML
if dc --file "$workdir/never-healthy.yml" up --detach >/dev/null 2>&1; then
  fail "docker compose up succeeded although the app never became healthy"
fi
runner_state=$(state_of runner)
case "$runner_state" in
  "" | created) printf '    runner state: %s\n' "${runner_state:-not created}" ;;
  *) fail "the runner is '$runner_state' although the app never became healthy" ;;
esac
dc down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1

# CR-37-T04
step "starting the stack on a fresh volume and waiting for it"
dc up --detach --wait --wait-timeout "$WAIT_SECONDS" >/dev/null 2>&1 || fail_with_logs "docker compose up --wait failed"
app_is_healthy || fail_with_logs "the app is not healthy: '$(health_of app)'"
runner_is_running || fail_with_logs "the runner is not running: '$(state_of runner)'"
port=$(host_port)
[ -n "$port" ] || fail "no host port is published for the app"

step "the app answers on its published port"
health=$(curl --silent --fail --max-time 5 "http://127.0.0.1:$port/api/health") || fail_with_logs "GET /api/health failed"
[ "$health" = '{"status":"ok"}' ] || fail "unexpected health answer: $health"

# CR-37-T02
step "the runner publishes no port and the app keeps /data in a named volume"
published=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$(container_of runner)")
[ "$published" = "{}" ] || [ "$published" = "null" ] || fail "the runner publishes ports: $published"
mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}} {{.Name}}{{end}}{{end}}' "$(container_of app)")
[[ "$mount" == "volume "* ]] || fail "/data is not a named volume of the app: '$mount'"

# CR-37-T04: no error loop in the runner log, a connection to the app instead.
step "the runner reports a connection to the app and no failure"
wait_until "the runner to report its connection" 30 runner_reports_connection
runner_log=$(dc logs --no-color runner 2>&1)
if grep -q 'cannot reach' <<<"$runner_log"; then
  printf '%s\n' "$runner_log" >&2
  fail "the runner log reports that it cannot reach the app"
fi
[ "$(docker inspect --format '{{.RestartCount}}' "$(container_of runner)")" = "0" ] || fail "the runner restarted"

# CR-37-T06: a record in the database survives `down` (without -v) and `up`.
step "the database survives down and up"
dc exec -T app node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/data/app.db");
  db.exec("pragma busy_timeout = 5000");
  db.exec("create table if not exists smoke_marker (value text not null)");
  db.exec("insert into smoke_marker (value) values (\x27kept\x27)");
' || fail_with_logs "could not write the marker record into /data/app.db"
dc down --timeout 20 >/dev/null 2>&1 || fail "docker compose down failed"
[ -z "$(dc ps --all --quiet)" ] || fail "containers are left after down"
dc up --detach --wait --wait-timeout "$WAIT_SECONDS" >/dev/null 2>&1 || fail_with_logs "docker compose up failed after down"
kept=$(dc exec -T app node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/data/app.db", { readOnly: true });
  console.log(db.prepare("select value from smoke_marker").get().value);
') || fail_with_logs "could not read the marker record after down and up"
[ "$kept" = "kept" ] || fail "the marker record is gone after down and up (got '$kept')"

# CR-37-T07: an app process that dies on its own (a crash, the out-of-memory killer) comes back
# through the restart policy; the runner stays up and finds the app again without anybody touching
# it. `docker kill` and `docker stop` are not used: with `unless-stopped` Docker treats them as a
# deliberate stop and leaves the container stopped (that is the point of the policy). Instead the
# server is told to terminate from inside the container; its own exit is what the policy sees.
step "an app process that exits by itself restarts, becomes healthy again, and the runner reaches it"
started=$(docker inspect --format '{{.State.StartedAt}}' "$(container_of app)")
dc exec -T app sh -c 'kill -TERM 1' || fail_with_logs "could not signal the app process"
wait_until "the app to restart and become healthy" "$WAIT_SECONDS" app_restarted_and_healthy "$started"
[ "$(docker inspect --format '{{.RestartCount}}' "$(container_of app)")" -ge 1 ] || fail "the app was not restarted by the restart policy"
runner_is_running || fail_with_logs "the runner is not running after the app restarted"
wait_until "the runner to reach the restarted app" 60 runner_reports_connection_last
[ "$(docker inspect --format '{{.RestartCount}}' "$(container_of runner)")" = "0" ] || fail "the runner had to be restarted"

step "compose smoke test passed"
