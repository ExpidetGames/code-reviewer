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
# waits for a healthy app, the stack comes up with the real job loop, the database survives `down`
# and `up`, a killed app container comes back by itself, a backup made in the running stack restores
# into an empty data volume, and `docker compose stop` while a review runs lets the runner report
# that review before it exits (the one step that uses a fake PR-Agent, from an override file that
# is not part of any deployment). Containers, networks and volumes are removed on exit, also
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
unset RUNNER_CONCURRENCY RUNNER_JOB_TIMEOUT_SECONDS RUNNER_POLL_INTERVAL_SECONDS RUNNER_ID PR_AGENT_COMMAND
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
runner_has_started() {
  local log
  log=$(dc logs --no-color runner 2>&1)
  grep -Eq 'runner [^ ]+ started: [0-9]+ slots' <<<"$log"
}
# The job loop logs nothing while it claims successfully and finds nothing to do, and a warning or
# an error whenever the app cannot be reached or refuses it (a wrong token is a 401 there).
runner_log_has_trouble() {
  dc logs --no-color runner 2>&1 | grep -Eq 'trying again in|claim failed|unexpected runner error|Traceback'
}
host_port() { dc port app 3000 | head -n 1 | sed 's/.*://'; }

# CR-37-T01
step "the compose file validates with a complete configuration and defines exactly app and runner"
dc config --quiet || fail "docker compose config failed with a complete configuration"
services=$(dc config --services | sort | tr '\n' ' ')
[ "$services" = "app runner " ] || fail "expected the services 'app runner', got '$services'"

# CR-39-T02: the file Coolify deploys (compose.coolify.yml) is valid with the same settings, plus the
# public address it requires, and refuses an empty one by name. Only the configuration is rendered;
# nothing is built or started from it here.
step "compose.coolify.yml validates with a complete configuration and names a missing public address"
coolify_file="$repo_root/compose.coolify.yml"
# --env-file /dev/null: a developer's own .env in the repository root must not leak into these checks.
BETTER_AUTH_URL=https://reviews.example.com docker compose --project-name "$project" \
  --project-directory "$repo_root" --env-file /dev/null --file "$coolify_file" config --quiet ||
  fail "docker compose config failed on compose.coolify.yml with a complete configuration"
coolify_services=$(BETTER_AUTH_URL=https://reviews.example.com docker compose --project-name "$project" \
  --project-directory "$repo_root" --env-file /dev/null --file "$coolify_file" config --services | sort | tr '\n' ' ')
[ "$coolify_services" = "app runner " ] || fail "compose.coolify.yml defines '$coolify_services', expected 'app runner'"
if message=$(env -u BETTER_AUTH_URL docker compose --project-name "$project" \
  --project-directory "$repo_root" --env-file /dev/null --file "$coolify_file" config --quiet 2>&1); then
  fail "compose.coolify.yml is valid without BETTER_AUTH_URL"
fi
grep -q 'BETTER_AUTH_URL' <<<"$message" || fail "the message does not name BETTER_AUTH_URL: $message"

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
if unhealthy_output=$(dc --file "$workdir/never-healthy.yml" up --detach 2>&1); then
  fail "docker compose up succeeded although the app never became healthy"
fi
# Any other failure of `up` (a typo in the override above, a port clash) must not pass for this one.
grep -qi 'unhealthy' <<<"$unhealthy_output" ||
  fail "the output of up does not name the unhealthy app: $unhealthy_output"
printf '    up said: %s\n' "$(grep -i -m1 'unhealthy' <<<"$unhealthy_output")"
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

# CR-39-T01, CR-51-T01: the smoke test of a running instance, here against the stack on its published
# port, including the check that the runner API refuses a request without a token.
step "the instance smoke test passes against the running stack"
"$here/instance.sh" "http://127.0.0.1:$port" ||
  fail_with_logs "docker/smoke/instance.sh failed against the running stack"

# CR-37-T02
step "the app is published on loopback only, the runner publishes no port, /data is a named volume"
binding=$(docker inspect --format '{{range (index .NetworkSettings.Ports "3000/tcp")}}{{.HostIp}} {{end}}' "$(container_of app)")
[ "$binding" = "127.0.0.1 " ] || fail "the app is published on '$binding', expected only 127.0.0.1"
published=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$(container_of runner)")
[ "$published" = "{}" ] || [ "$published" = "null" ] || fail "the runner publishes ports: $published"
mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}} {{.Name}}{{end}}{{end}}' "$(container_of app)")
[[ "$mount" == "volume "* ]] || fail "/data is not a named volume of the app: '$mount'"

# CR-37-T04, CR-51-T01: the image's own entry point, the job loop, runs and the app accepts its token.
# Two polls pass (5 s each) without a warning: a wrong token, address or an unreachable app would show
# as "trying again in" in the log. The token itself must never appear in it.
step "the runner starts its job loop and polls the app without a failure"
wait_until "the runner to log that it started" 30 runner_has_started
sleep 12
runner_log=$(dc logs --no-color runner 2>&1)
if runner_log_has_trouble; then
  printf '%s\n' "$runner_log" >&2
  fail "the runner log reports a failing connection to the app"
fi
grep -qF "$RUNNER_TOKEN" <<<"$runner_log" && fail "the runner token is in the runner log"
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
# it. (The loop logs nothing when a claim succeeds, so this shows that the runner survived the outage
# and keeps running, not that its next claim got through; its back-off after an outage is tested in
# runner/tests.) `docker kill` and `docker stop` are not used: with `unless-stopped` Docker treats them as a
# deliberate stop and leaves the container stopped (that is the point of the policy). Instead the
# server is told to terminate from inside the container; its own exit is what the policy sees.
step "an app process that exits by itself restarts, becomes healthy again, and the runner keeps running"
started=$(docker inspect --format '{{.State.StartedAt}}' "$(container_of app)")
dc exec -T app sh -c 'kill -TERM 1' || fail_with_logs "could not signal the app process"
wait_until "the app to restart and become healthy" "$WAIT_SECONDS" app_restarted_and_healthy "$started"
[ "$(docker inspect --format '{{.RestartCount}}' "$(container_of app)")" -ge 1 ] || fail "the app was not restarted by the restart policy"
runner_is_running || fail_with_logs "the runner is not running after the app restarted"
sleep 12
runner_is_running || fail_with_logs "the runner is not running after the app restarted"
if dc logs --no-color runner 2>&1 | grep -Eq 'runner [^ ]+ stopped|Traceback'; then
  fail_with_logs "the job loop ended or crashed while the app restarted"
fi
[ "$(docker inspect --format '{{.RestartCount}}' "$(container_of runner)")" = "0" ] || fail "the runner had to be restarted"

# CR-40-T04, CR-40-T10, CR-40-T12: the backup command in the running app container writes a verified
# file with restrictive permissions to the /backups volume (not to /data); after the data volume is
# thrown away, the documented restore (a one-off container on the same volumes) brings the data back
# and the app becomes healthy on it. The database holds the marker record from the step above.
step "a backup of the running stack restores into an empty data volume and the app is healthy again"
backup_output=$(dc exec -T app node backup/cli.ts backup 2>&1) || fail_with_logs "the backup command failed: $backup_output"
backup_file=$(dc exec -T app sh -c 'ls /backups' | head -n 1 | tr -d '\r')
[[ "$backup_file" =~ ^code-reviewer-[0-9]{8}T[0-9]{6}Z\.db$ ]] || fail "unexpected backup file name: '$backup_file'"
grep -q "created /backups/$backup_file " <<<"$backup_output" || fail "the backup output does not name the file: $backup_output"
[ "$(dc exec -T app sh -c "stat -c %a /backups/$backup_file" | tr -d '\r')" = "600" ] || fail "the backup is not readable by its owner only"
dc exec -T app sh -c 'ls /data' | grep -q 'code-reviewer-' && fail "a backup was written into /data"
backups_mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/backups"}}{{.Type}}{{end}}{{end}}' "$(container_of app)")
[ "$backups_mount" = "volume" ] || fail "/backups is not a volume of the app: '$backups_mount'"

dc down --timeout 20 >/dev/null 2>&1 || fail "docker compose down failed before the restore"
docker volume rm "${project}_data" >/dev/null || fail "could not remove the data volume"
restore_output=$(dc run --rm --no-deps -T app node backup/cli.ts restore "/backups/$backup_file" 2>&1) ||
  fail "the restore command failed: $restore_output"
grep -q "restored /backups/$backup_file to /data/app.db" <<<"$restore_output" || fail "unexpected restore output: $restore_output"
dc up --detach --wait --wait-timeout "$WAIT_SECONDS" >/dev/null 2>&1 || fail_with_logs "docker compose up failed after the restore"
app_is_healthy || fail_with_logs "the app is not healthy after the restore: '$(health_of app)'"
restored=$(dc exec -T app node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/data/app.db", { readOnly: true });
  console.log(db.prepare("select value from smoke_marker").get().value);
') || fail_with_logs "could not read the marker record after the restore"
[ "$restored" = "kept" ] || fail "the marker record is missing after the restore (got '$restored')"

# CR-40-T07: a backup that cannot be made fails the command with a message and leaves no file.
step "a backup into a directory that is not there fails with a message and creates nothing"
if failure=$(dc exec -T -e BACKUP_DIR=/nowhere app node backup/cli.ts backup 2>&1); then
  fail "the backup command succeeded although its target is missing"
fi
grep -q 'BACKUP_TARGET_UNAVAILABLE' <<<"$failure" || fail "the failure does not name its code: $failure"
[ "$(dc exec -T app sh -c 'ls /backups | wc -l' | tr -d '\r')" = "1" ] || fail "the failed backup changed /backups"

# CR-51-T04: `docker compose stop` while a review runs. The override file swaps the app's runner API for
# a fake that hands out one job, and PR-Agent for a fake that never finishes (PR_AGENT_COMMAND is set
# there and nowhere else). The runner must stop claiming, give the review its grace period (20 s here,
# 60 s in the shipped files), report it as runner_shutdown and exit by itself with status 0: Docker
# must not kill it after its default of 10 seconds.
step "docker compose stop while a review runs: the runner reports the review and exits by itself"
dc down --timeout 20 >/dev/null 2>&1 || fail "docker compose down failed before the stop test"
mkdir -p "$workdir/smoke-fakes"
cp "$here/fakes/fake_runner_api.py" "$here/fakes/fake_job.py" "$workdir/smoke-fakes/"
cp "$here/compose.fake-job.yml" "$workdir/compose.fake-job.yml"
# The containers run as an unprivileged user and must be able to read the copies.
chmod 755 "$workdir/smoke-fakes"
chmod 644 "$workdir/smoke-fakes/"*
dco() {
  docker compose --project-name "$project" --project-directory "$workdir" \
    --file "$workdir/compose.yml" --file "$workdir/compose.fake-job.yml" "$@"
}
review_is_running() { dco exec -T runner test -f /tmp/fake-job-started; }
dco up --detach --wait --wait-timeout "$WAIT_SECONDS" >/dev/null 2>&1 || {
  dco logs --no-color >&2 || true
  fail "docker compose up failed with the fake runner API"
}
wait_until "the runner to claim the fake review and start it" 60 review_is_running
runner_id=$(dco ps --all --quiet runner | head -n 1)
[ -n "$runner_id" ] || fail "no runner container"
stop_started=$SECONDS
dco stop >/dev/null 2>&1 || fail "docker compose stop failed"
stop_seconds=$((SECONDS - stop_started))
printf '    docker compose stop took %s s\n' "$stop_seconds"
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$runner_id")
runner_log=$(docker logs "$runner_id" 2>&1)
api_log=$(dco logs --no-color --no-log-prefix fake-api 2>&1)
[ "$exit_code" = "0" ] || { printf '%s\n' "$runner_log" >&2; fail "the runner exited with $exit_code instead of 0 (killed before it could report?)"; }
[ "$stop_seconds" -ge 15 ] || fail "the stop took only $stop_seconds s: the running review was not given its grace period"
[ "$stop_seconds" -lt 90 ] || fail "the stop took $stop_seconds s, as long as stop_grace_period"
grep -q 'stopping: 1 job(s) may finish within 20s' <<<"$runner_log" || { printf '%s\n' "$runner_log" >&2; fail "the runner did not log that it waits for the running review"; }
grep -q '^COMPLETE .*"errorCode": "runner_shutdown"' <<<"$api_log" || { printf '%s\n' "$api_log" >&2; fail "the runner API did not receive the review as runner_shutdown"; }
grep -q '"ok": false' <<<"$(grep '^COMPLETE' <<<"$api_log")" || fail "the shutdown report is not marked as failed"
[ "$(grep -c '^COMPLETE' <<<"$api_log")" = "1" ] || fail "expected exactly one report"
grep -qF "$RUNNER_TOKEN" <<<"$runner_log" && fail "the runner token is in the runner log"
dco down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true

step "compose smoke test passed"
