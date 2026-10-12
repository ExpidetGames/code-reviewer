#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# Smoke test of a running Code Reviewer instance, reached over HTTP(S). It needs nothing but curl and
# no secret: it only sends requests that a healthy instance must refuse or answer without a session.
#
# Usage: docker/smoke/instance.sh <base-url>
#   <base-url>  the address people use, for example https://reviews.example.com (no path)
#
# Checks (the exit code is 0 only when every one of them passes):
#   0. the instance is set up         an instance that is not set up yet answers every request but the
#                                     health check with 503 setup_required: finish the first-run setup
#                                     in the browser (the setup code is in the log of the app) first
#   1. GET  /api/health                 answers 2xx (the app is up and reads its database)
#   2. GET  /login                      answers 2xx (the login page loads)
#   3. POST /api/webhooks/github-app    with a wrong signature answers 401 (deliveries are verified)
#   4. POST /api/runners/v1/claim       without a token answers 401 (the runner API is closed)
# Redirects are not followed: a redirect is not a 2xx, and a proxy that sends http to https must not
# hide a broken instance behind a 200 of the login page.
#
# Exit codes: 0 all checks passed, 1 a check failed (or the instance is not reachable), 2 usage.
set -uo pipefail

usage() {
  printf 'Usage: %s <base-url>\n' "${0##*/}" >&2
  exit 2
}

base=""
for argument in "$@"; do
  case "$argument" in
    -h | --help) usage ;;
    -*) printf 'unknown option: %s\n' "$argument" >&2; usage ;;
    *)
      [ -z "$base" ] || usage
      base=$argument
      ;;
  esac
done
[ -n "$base" ] || usage
case "$base" in
  http://* | https://*) ;;
  *) printf 'the base URL must start with http:// or https://: %s\n' "$base" >&2; exit 2 ;;
esac
command -v curl >/dev/null || { printf 'curl is required\n' >&2; exit 2; }
base=${base%/}

failures=0

# Prints the HTTP status of a request, or 000 when there is no answer.
# Usage: status <curl arguments...> <url>
status() {
  local code
  code=$(curl --silent --show-error --max-time 15 --output /dev/null --write-out '%{http_code}' "$@" 2>/dev/null) || true
  printf '%s' "${code:-000}"
}

# Usage: expect <description> <expected: "2xx" or a status> <actual>
expect() {
  local description=$1 expected=$2 actual=$3 ok=0
  case "$expected" in
    2xx) [[ "$actual" =~ ^2[0-9][0-9]$ ]] && ok=1 ;;
    *) [ "$actual" = "$expected" ] && ok=1 ;;
  esac
  if [ "$ok" = 1 ]; then
    printf 'ok      %s (%s)\n' "$description" "$actual"
  else
    printf 'FAILED  %s: expected %s, got %s\n' "$description" "$expected" "$actual" >&2
    failures=$((failures + 1))
  fi
}

printf '==> smoke test of %s\n' "$base"

# A fresh instance (or an update that has not been set up yet) refuses the web UI, the webhooks and the
# runner API with 503 setup_required until the first-run setup is finished in the browser. Say so
# instead of reporting three confusing failures.
probe=$(curl --silent --max-time 15 --write-out '\n%{http_code}' --request POST "$base/api/runners/v1/claim" 2>/dev/null) || true
probe_status=${probe##*$'\n'}
if [ "$probe_status" = 503 ] && [[ "$probe" == *setup_required* ]]; then
  printf 'FAILED  the instance is not set up yet: open %s in a browser, enter the setup code from the log of the app and finish the setup, then run this again\n' "$base" >&2
  printf 'SMOKE TEST FAILED: %s is waiting for the first-run setup\n' "$base" >&2
  exit 1
fi

expect "GET /api/health" 2xx "$(status "$base/api/health")"
expect "GET /login" 2xx "$(status "$base/login")"

# A delivery signed with the wrong key. The event and delivery headers are well formed, so the only
# thing wrong with it is the signature. 64 zeros are a syntactically valid but wrong digest.
wrong_signature="sha256=$(printf '0%.0s' {1..64})"
expect "POST /api/webhooks/github-app with a wrong signature" 401 "$(status \
  --request POST \
  --header 'Content-Type: application/json' \
  --header 'X-GitHub-Event: ping' \
  --header "X-GitHub-Delivery: smoke-$(date +%s)-$$" \
  --header "X-Hub-Signature-256: $wrong_signature" \
  --data '{"zen":"smoke test"}' \
  "$base/api/webhooks/github-app")"

expect "POST /api/runners/v1/claim without a token" 401 "$(status --request POST "$base/api/runners/v1/claim")"

if [ "$failures" -gt 0 ]; then
  printf 'SMOKE TEST FAILED: %s check(s) failed against %s\n' "$failures" "$base" >&2
  exit 1
fi
printf 'smoke test passed\n'
