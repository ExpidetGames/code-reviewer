#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# Smoke test of the update from the previous release. Usage: docker/smoke/upgrade.sh <image>
# (default: code-reviewer-app:local)
#
# Puts the database of the previous release (docker/smoke/fixtures/previous-release.sql: three people who signed
# in with GitHub, a connection with two repositories, finished reviews) into the data volume of the image under
# test and starts the image with the environment of the previous release (the GitHub App, the LLM key, the allow
# list and BETTER_AUTH_SECRET only), the way an operator updates. Checks what only the built image can show:
# the update does not start when its backup cannot be written and leaves the database untouched; after the cause
# is fixed it backs up first, migrates and imports once, becomes healthy, prints one setup code, keeps answering
# webhooks with the imported secret and the runner API during the setup window, writes no secret to its log;
# a restart imports nothing twice; and after the short setup and the removal of the old variables (APP_SECRET with
# the value of BETTER_AUTH_SECRET) the instance still works. Nothing talks to GitHub or to a model.
# Needs only Docker, openssl and curl; fails without them, never skips.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=docker/smoke/lib.sh
source "$here/lib.sh"

image=${1:-code-reviewer-app:local}
readonly WAIT_SECONDS=${SMOKE_WAIT_SECONDS:-90}
suffix="$$-$RANDOM"
data="cr-smoke-upgrade-data-$suffix"
backups="cr-smoke-upgrade-backups-$suffix"
container="cr-smoke-upgrade-$suffix"
work=$(mktemp -d)
extra_cleanup() { rm -rf "$work"; }

command -v openssl >/dev/null || fail "openssl is needed"
command -v curl >/dev/null || fail "curl is needed"
require_image "$image"
CLEANUP_CONTAINERS+=("$container")
CLEANUP_VOLUMES+=("$data" "$backups")

user=$(docker image inspect --format '{{.Config.User}}' "$image")
fixture="$here/fixtures/previous-release.sql"
[ -s "$fixture" ] || fail "the fixture $fixture is missing"

# What the operator of the previous release had in the environment. The values are dummies; each one must
# stay out of the log of the update.
secret=smoke-previous-release-secret-0123456789-abcdef
webhook_secret=smoke-webhook-secret-0123456789
llm_key=smoke-llm-key-0123456789-0123456789
oauth_secret=smoke-oauth-client-secret-0123456789
runner_token=smoke-runner-token-0123456789-0123456789-abcdef
openssl genrsa -traditional 2048 >"$work/app.pem" 2>/dev/null || openssl genrsa 2048 >"$work/app.pem" 2>/dev/null
private_key=$(cat "$work/app.pem")
key_body_line=$(sed -n 2p "$work/app.pem")

previous_release_environment=(
  --env "BETTER_AUTH_SECRET=$secret"
  --env BETTER_AUTH_URL=http://localhost:3000
  --env MODELS_DEV_FETCH=off
  --env "RUNNER_TOKEN=$runner_token"
  --env GITHUB_OAUTH_CLIENT_ID=smoke-oauth-client-id
  --env "GITHUB_OAUTH_CLIENT_SECRET=$oauth_secret"
  --env ALLOWED_GITHUB_LOGINS=smoke-alice,smoke-bob,smoke-zed
  --env GITHUB_APP_ID=424242
  --env GITHUB_APP_SLUG=smoke-code-reviewer
  --env "GITHUB_APP_PRIVATE_KEY=$private_key"
  --env "GITHUB_APP_WEBHOOK_SECRET=$webhook_secret"
  --env LLM_PROVIDER=openrouter
  --env "LLM_API_KEY=$llm_key"
)
new_release_environment=(
  --env "APP_SECRET=$secret"
  --env BETTER_AUTH_URL=http://localhost:3000
  --env MODELS_DEV_FETCH=off
  --env "RUNNER_TOKEN=$runner_token"
)

# Loads the fixture into /data/app.db as the image's own user, so that the file belongs to the user that
# runs the app, like a database the previous release wrote.
step "putting the database of the previous release into a fresh data volume"
docker volume create "$data" >/dev/null
docker volume create "$backups" >/dev/null
docker run --rm --user "$user" --entrypoint node \
  --volume "$data:/data" --volume "$fixture:/fixture.sql:ro" "$image" --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/data/app.db");
    db.exec("pragma journal_mode = wal");
    db.exec(require("node:fs").readFileSync("/fixture.sql", "utf8"));
    const n = db.prepare("select count(*) as n from users").get().n;
    if (n !== 3) throw new Error("the fixture holds " + n + " users, expected 3");
    db.close();
  ' || fail "the fixture could not be loaded"

# Reads one value from the database in the volume with a throwaway container (read only), so it also works
# while no app container runs.
query_database() {
  docker run --rm --user "$user" --entrypoint node --volume "$data:/data" "$image" --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/data/app.db", { readOnly: true });
    const rows = db.prepare(process.argv[1]).all();
    console.log(JSON.stringify(rows));
  ' "$1"
}
tables_of_database() {
  query_database "select group_concat(name) as tables from sqlite_master where type = 'table'"
}

wait_healthy() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  until [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" = "healthy" ]; do
    state=$(docker inspect --format '{{.State.Status}}' "$container")
    if [ "$state" != "running" ]; then
      docker logs "$container" >&2 || true
      fail "the container stopped (state: $state) before it became healthy"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      docker logs "$container" >&2 || true
      fail "the container did not become healthy within ${WAIT_SECONDS}s"
    fi
    sleep 1
  done
}

# Starts the container with the given backup mount mode and environment arguments.
start_app() {
  local backup_mode=$1
  shift
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker run --detach --name "$container" \
    --publish 127.0.0.1::3000 \
    --volume "$data:/data" \
    --volume "$backups:/backups:$backup_mode" \
    --health-interval 2s \
    "$@" "$image" >/dev/null
}

port_of_container() {
  docker port "$container" 3000/tcp | head -n 1 | sed 's/.*://'
}

# #106-IM-17: a backup that cannot be written stops the update before anything is changed.
step "an update whose backup cannot be written does not start and leaves the database as it was"
tables_before=$(tables_of_database)
start_app ro "${previous_release_environment[@]}"
deadline=$((SECONDS + WAIT_SECONDS))
while [ "$(docker inspect --format '{{.State.Status}}' "$container")" = "running" ]; do
  [ "$SECONDS" -lt "$deadline" ] || {
    docker logs "$container" >&2 || true
    fail "the update did not stop although its backup cannot be written"
  }
  sleep 1
done
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container")
logs=$(docker logs "$container" 2>&1)
[ "$exit_code" = 1 ] || fail "the update ended with exit code $exit_code, expected 1"
grep -q 'UPDATE_BACKUP_FAILED' <<<"$logs" || fail "the log does not say that the backup failed"
grep -q 'the database was not changed' <<<"$logs" || fail "the log does not say that the database was not changed"
grep -q 'Setup code' <<<"$logs" && fail "a setup code was printed although the update did not start"
[ "$(tables_of_database)" = "$tables_before" ] || fail "the database was changed although the backup failed"

# #106-IM-01, #106-IM-20: the cause is fixed (a writable backup volume), the update runs.
step "after the cause is fixed the update backs up, migrates and imports, and the image becomes healthy"
start_app rw "${previous_release_environment[@]}"
wait_healthy
port=$(port_of_container)
logs=$(docker logs "$container" 2>&1)
for marker in BACKUP_BEFORE_UPDATE '\[backup\] created' 'applied migrations' IMPORT_DONE LEGACY_VARIABLES_IGNORED 'Setup code:'; do
  grep -Eq "$marker" <<<"$logs" || {
    printf '%s\n' "$logs" >&2
    fail "the log of the update has no '$marker'"
  }
done
code=$(setup_code_from_log "$logs") || exit 1
ignored=$(grep 'LEGACY_VARIABLES_IGNORED' <<<"$logs")
for name in GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_APP_WEBHOOK_SECRET GITHUB_OAUTH_CLIENT_SECRET ALLOWED_GITHUB_LOGINS LLM_API_KEY; do
  grep -q "$name" <<<"$ignored" || fail "the line about the ignored variables does not name $name"
done

step "the log holds no secret"
for value in "$secret" "$webhook_secret" "$llm_key" "$oauth_secret" "$runner_token" "$key_body_line"; do
  grep -qF -- "$value" <<<"$logs" && fail "a secret ($(printf '%s' "$value" | cut -c1-6)...) is in the log"
done

step "the backup is the database as the previous release left it, and the import is in the database"
backup_count=$(docker run --rm --entrypoint sh --volume "$backups:/backups:ro" "$image" -c 'ls /backups | wc -l')
[ "$(printf '%s' "$backup_count" | tr -d ' ')" = 1 ] || fail "expected one backup, found $backup_count"
# The backup is copied out and read in a throwaway container of its own: opening a database in the backup
# volume itself could leave side files in it.
docker run --rm --entrypoint sh --volume "$backups:/backups:ro" "$image" -c 'cat /backups/*' >"$work/backup.db"
backup_check=$(docker run --rm --user 0 --entrypoint node --volume "$work:/work" "$image" --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/work/backup.db");
  const tables = db.prepare("select name, type from sqlite_master").all().filter((row) => row.type === "table").map((row) => row.name);
  console.log(JSON.stringify({ workspaces: tables.includes("workspaces"), users: db.prepare("select count(*) as n from users").get().n }));
')
[ "$backup_check" = '{"workspaces":false,"users":3}' ] || fail "the backup is not the database of the previous release: $backup_check"
state=$(query_database "select (select count(*) from workspaces) as workspaces, (select count(*) from workspace_members) as members, (select count(*) from workspace_members where role = 'owner') as owners, (select count(*) from users where imported_at is not null) as imported, (select count(*) from secrets) as secrets, (select count(*) from workspace_secrets) as workspace_secrets, (select value from instance_settings where key = 'import_state') as import_state, (select count(*) from instance_settings where key = 'setup_completed_at') as set_up, (select count(*) from jobs) as jobs")
[ "$state" = '[{"workspaces":1,"members":2,"owners":1,"imported":3,"secrets":2,"workspace_secrets":1,"import_state":"\"done\"","set_up":0,"jobs":2}]' ] ||
  fail "the database after the import is not as expected: $state"

# #106-IM-02, #106-IM-20: the setup window. Only the web UI waits; the webhook route verifies with the secret
# that was imported from the environment, and the runner API accepts the runner token.
step "during the setup window the webhook route and the runner API keep answering"
start_page=$(curl --silent --max-time 5 "http://127.0.0.1:$port/")
grep -q 'Set up Code Reviewer' <<<"$start_page" || fail "the start page does not show the setup"
send_ping() {
  local base=$1 secret_value=$2 body signature
  body='{"zen":"Keep it logically awesome.","hook_id":1}'
  signature=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret_value" -r | cut -d' ' -f1)
  curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
    --request POST --header 'Content-Type: application/json' \
    --header 'X-GitHub-Event: ping' --header "X-GitHub-Delivery: smoke-$RANDOM$RANDOM" \
    --header "X-Hub-Signature-256: sha256=$signature" --data "$body" "$base/api/webhooks/github-app"
}
[ "$(send_ping "http://127.0.0.1:$port" "$webhook_secret")" = 202 ] ||
  fail "a delivery signed with the webhook secret of the environment was not accepted"
[ "$(send_ping "http://127.0.0.1:$port" "not-the-secret")" = 401 ] ||
  fail "a delivery signed with another secret was not refused with 401"
claim_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
  --request POST --header "Authorization: Bearer $runner_token" --header 'X-Runner-Id: smoke-runner' \
  "http://127.0.0.1:$port/api/runners/v1/claim")
[ "$claim_status" = 204 ] || fail "the runner API did not answer 204 (no job) during the setup window (got $claim_status)"

# #106-IM-22: a restart before the wizard prints a new code and imports nothing twice.
step "a restart before the wizard prints a new code and imports nothing twice"
lines_before=$(docker logs "$container" 2>&1 | wc -l)
docker restart "$container" >/dev/null
wait_healthy
restart_logs=$(docker logs "$container" 2>&1 | tail -n "+$((lines_before + 1))")
second_code=$(setup_code_from_log "$restart_logs") || exit 1
grep -q 'IMPORT_DONE' <<<"$restart_logs" && fail "the import ran again after the restart"
grep -q 'BACKUP_BEFORE_UPDATE' <<<"$restart_logs" && fail "another backup was taken after the restart"
[ "$(query_database 'select count(*) as n from workspace_members')" = '[{"n":2}]' ] ||
  fail "the restart changed the members"
backup_count=$(docker run --rm --entrypoint sh --volume "$backups:/backups:ro" "$image" -c 'ls /backups | wc -l')
[ "$(printf '%s' "$backup_count" | tr -d ' ')" = 1 ] || fail "the restart took another backup ($backup_count)"
port=$(port_of_container)

step "the short setup finishes, and the instance is set up"
complete_setup "http://127.0.0.1:$port" "$second_code"

# #106-IM-02, #106-IM-11: the operator removes the old variables and adds APP_SECRET with the old value.
step "without the old variables, and with APP_SECRET in place of BETTER_AUTH_SECRET, the instance still works"
docker rm --force "$container" >/dev/null
start_app rw "${new_release_environment[@]}"
wait_healthy
port=$(port_of_container)
new_logs=$(docker logs "$container" 2>&1)
grep -q 'Setup code' <<<"$new_logs" && fail "a set up instance printed a setup code"
grep -q 'IMPORT_DONE' <<<"$new_logs" && fail "the import ran again"
grep -q 'LEGACY_VARIABLES_IGNORED' <<<"$new_logs" && fail "the old variables are gone, so nothing should be reported as ignored"
[ "$(send_ping "http://127.0.0.1:$port" "$webhook_secret")" = 202 ] ||
  fail "the webhook secret that was imported is not used after the old variables are gone"
[ "$(send_ping "http://127.0.0.1:$port" "not-the-secret")" = 401 ] ||
  fail "a delivery signed with another secret was accepted"
claim_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
  --request POST --header "Authorization: Bearer $runner_token" --header 'X-Runner-Id: smoke-runner' \
  "http://127.0.0.1:$port/api/runners/v1/claim")
[ "$claim_status" = 204 ] || fail "the runner API did not answer 204 after the old variables are gone (got $claim_status)"
status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "http://127.0.0.1:$port/setup")
[ "$status" = 404 ] || fail "/setup answers $status on a set up instance"
for value in "$secret" "$webhook_secret" "$llm_key" "$runner_token" "$key_body_line"; do
  grep -qF -- "$value" <<<"$new_logs" && fail "a secret is in the log of the restart"
done

step "upgrade smoke test passed"
