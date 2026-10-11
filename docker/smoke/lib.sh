#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# Shared helpers of the smoke tests (docker/smoke/app.sh, runner.sh and compose.sh). Sourced,
# not executed. The smoke tests need a Docker daemon and fail loudly without one; they never skip.

# Output goes to stderr only for failures; progress lines are plain.
step() { printf '==> %s\n' "$*"; }
fail() {
  printf 'SMOKE TEST FAILED: %s\n' "$*" >&2
  exit 1
}

# Unsets every variable the given compose files interpolate (${NAME}, ${NAME:-default}, nested
# ones and the short form $NAME), so that a value in the caller's shell or in CI cannot change what
# a smoke test runs against. The list is read from the files, not written by hand: a variable added
# to a compose file later is covered without anyone remembering it. Call it before exporting the
# dummy settings. `$$` is an escaped dollar sign in a compose file and interpolates nothing, so it
# is removed before matching ($${HOME} must not unset HOME). A name that cannot be unset (a read
# only one such as UID) is skipped. A missing file is an error: reading no file would unset
# nothing and look like success.
# Usage: unset_compose_variables <compose file>...
unset_compose_variables() {
  local file name names
  [ "$#" -gt 0 ] || {
    printf 'unset_compose_variables: no compose file given\n' >&2
    return 1
  }
  for file in "$@"; do
    [ -f "$file" ] || {
      printf 'unset_compose_variables: not a file: %s\n' "$file" >&2
      return 1
    }
  done
  # `|| true`: grep exits 1 for a file without any variable, which is fine.
  names=$({ sed 's/\$\$//g' "$@" | grep -oE '\$\{?[A-Za-z_][A-Za-z0-9_]*' | sed -E 's/^\$\{?//' | sort -u; } || true)
  while read -r name; do
    [ -n "$name" ] || continue
    unset "$name" 2>/dev/null || true
  done <<<"$names"
}

# Containers and volumes created by a smoke run, removed on exit (also after a failure).
CLEANUP_CONTAINERS=()
CLEANUP_VOLUMES=()
cleanup() {
  local name
  for name in "${CLEANUP_CONTAINERS[@]:-}"; do
    [ -n "$name" ] && docker rm --force --volumes "$name" >/dev/null 2>&1
  done
  for name in "${CLEANUP_VOLUMES[@]:-}"; do
    [ -n "$name" ] && docker volume rm --force "$name" >/dev/null 2>&1
  done
  # A smoke test with more to clean up (a compose project, a temporary directory) defines this.
  if declare -F extra_cleanup >/dev/null; then extra_cleanup; fi
  return 0
}
trap cleanup EXIT

# The first-run setup, as a person does it, through the app's own API (the browser journey is a
# Playwright test). A fresh instance prints one setup code in its log and refuses everything but the
# health check until the setup is finished.

# Prints the setup code found in a log text, and fails unless the log has exactly one such line (a
# restart prints a new one, so pass only the log of the start in question).
# Usage: setup_code_from_log <log text>
setup_code_from_log() {
  local log=$1 count code
  count=$(grep -cE 'Setup code: [0-9]{6}( |$)' <<<"$log" || true)
  [ "$count" = 1 ] || fail "expected exactly one setup code line in the log, found $count"
  code=$(sed -nE 's/.*Setup code: ([0-9]{6})( .*|$)/\1/p' <<<"$log")
  [[ "$code" =~ ^[0-9]{6}$ ]] || fail "could not read the setup code from the log"
  printf '%s' "$code"
}

# Enters the code and finishes the wizard (single-tenant, everyone may sign up, an admin with a
# throwaway password that is generated here and never printed). Fails unless the instance then
# answers as a set up one: the setup page is gone (404) and a page without a session redirects to the
# login. The code never goes on a command line (it would show in the process list): it is sent from
# a file.
# Usage: complete_setup <base url> <code>
complete_setup() {
  local base=$1 code=$2 jar body password status
  jar=$(mktemp)
  body=$(mktemp)
  # A throwaway password, 24 random letters and digits: far from any list of common passwords.
  # (`|| true`: with pipefail, tr dies of SIGPIPE when head has its 24 characters.)
  password=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 || true)
  [ "${#password}" = 24 ] || fail "could not generate a password for the admin"
  printf '{"code":"%s"}' "$code" >"$body"
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
    --cookie-jar "$jar" --header 'Content-Type: application/json' --data "@$body" "$base/api/setup/code")
  [ "$status" = 200 ] || { rm -f "$jar" "$body"; fail "the setup code was not accepted (status $status)"; }
  printf '{"tenancy":"single","signUp":{"kind":"everyone"},"admin":{"email":"smoke-admin@example.test","password":"%s"}}' \
    "$password" >"$body"
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 20 \
    --cookie "$jar" --header 'Content-Type: application/json' --data "@$body" "$base/api/setup/complete")
  rm -f "$jar" "$body"
  [ "$status" = 200 ] || fail "the wizard was not accepted (status $status)"
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "$base/setup")
  [ "$status" = 404 ] || fail "the setup page still answers $status after the setup (expected 404)"
  status=$(curl --silent --output /dev/null --write-out '%{http_code} %{redirect_url}' --max-time 10 "$base/")
  [[ "$status" == "307 "*"/login" ]] || fail "after the setup the start page did not redirect to /login (got: $status)"
}

# #98-AD-01, #98-AD-17: the admin portal of a set up instance, in the built image. A visitor without a
# session is sent to the login (a page) or gets 401 (the data route). The operator's command
# `admin reset-password` prints a link; the link sets a new password once, ends the sessions, and the new
# password signs in and reaches the portal. The same link a second time is refused. The new password is
# random and never on a command line: it is sent from a file.
# Usage: check_admin_portal <base url> <container>
check_admin_portal() {
  local base=$1 container=$2 status output link token password body jar
  status=$(curl --silent --output /dev/null --write-out '%{http_code} %{redirect_url}' --max-time 10 "$base/admin")
  [[ "$status" == "307 "*"/login" ]] || fail "/admin without a session did not redirect to /login (got: $status)"
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "$base/api/admin/settings")
  [ "$status" = 401 ] || fail "/api/admin/settings without a session did not answer 401 (got: $status)"

  output=$(docker exec "$container" admin reset-password smoke-admin@example.test) ||
    fail "admin reset-password failed: $output"
  link=$(grep -m 1 '^http' <<<"$output") || fail "admin reset-password printed no link"
  token=${link##*token=}
  [[ "$token" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "the link has no well formed token"
  password=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 || true)
  [ "${#password}" = 24 ] || fail "could not generate a password for the reset"
  body=$(mktemp)
  jar=$(mktemp)
  printf '{"token":"%s","password":"%s"}' "$token" "$password" >"$body"
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 20 \
    --header 'Content-Type: application/json' --data "@$body" "$base/api/password-reset")
  [ "$status" = 200 ] || { rm -f "$body" "$jar"; fail "the reset link was not accepted (status $status)"; }
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 20 \
    --header 'Content-Type: application/json' --data "@$body" "$base/api/password-reset")
  [ "$status" = 400 ] || { rm -f "$body" "$jar"; fail "the reset link worked a second time (status $status)"; }

  printf '{"email":"smoke-admin@example.test","password":"%s"}' "$password" >"$body"
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 20 --cookie-jar "$jar" \
    --header 'Content-Type: application/json' --data "@$body" "$base/api/auth/sign-in/email")
  rm -f "$body"
  [ "$status" = 200 ] || { rm -f "$jar"; fail "the new password did not sign in (status $status)"; }
  output=$(curl --silent --max-time 10 --cookie "$jar" "$base/api/admin/settings") ||
    { rm -f "$jar"; fail "GET /api/admin/settings failed as the admin"; }
  grep -q '"tenancy"' <<<"$output" || { rm -f "$jar"; fail "the admin settings are not what the portal answers"; }
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 --cookie "$jar" "$base/admin")
  rm -f "$jar"
  [ "$status" = 200 ] || fail "/admin as the admin did not answer 200 (got: $status)"
}

# #99-SR-08, #99-SR-14, #99-SR-21: the sign-up of a set up instance (the wizard chose "everyone", and no
# mail server exists in the image), in the built image. The page is public, a sign-up creates an account
# that signs in at once, and the answer for an address that has an account is the same as for a new one.
# The new account belongs to no workspace: the start page sends it to /no-access and the data routes
# answer 403 no_workspace_access. The password is random and never on a command line: it is sent from a
# file.
# Usage: check_sign_up <base url>
check_sign_up() {
  local base=$1 status first again admin body jar password output
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "$base/sign-up")
  [ "$status" = 200 ] || fail "/sign-up without a session did not answer 200 (got: $status)"
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "$base/no-access")
  [ "$status" = 200 ] || fail "/no-access without a session did not answer 200 (got: $status)"

  password=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 || true)
  [ "${#password}" = 24 ] || fail "could not generate a password for the sign-up"
  body=$(mktemp)
  jar=$(mktemp)
  printf '{"email":"smoke-visitor@example.test","password":"%s"}' "$password" >"$body"
  first=$(curl --silent --max-time 20 --write-out ' %{http_code}' --header 'Content-Type: application/json'     --data "@$body" "$base/api/sign-up")
  [ "$first" = '{"ok":true,"next":"sign_in"} 200' ] || { rm -f "$body" "$jar"; fail "the sign-up was not accepted (got: $first)"; }
  again=$(curl --silent --max-time 20 --write-out ' %{http_code}' --header 'Content-Type: application/json'     --data "@$body" "$base/api/sign-up")
  [ "$again" = "$first" ] || { rm -f "$body" "$jar"; fail "a second sign-up for the same address was answered differently (got: $again)"; }
  printf '{"email":"smoke-admin@example.test","password":"%s"}' "$password" >"$body"
  admin=$(curl --silent --max-time 20 --write-out ' %{http_code}' --header 'Content-Type: application/json'     --data "@$body" "$base/api/sign-up")
  [ "$admin" = "$first" ] || { rm -f "$body" "$jar"; fail "a sign-up for the admin's address was answered differently (got: $admin)"; }

  printf '{"email":"smoke-visitor@example.test","password":"%s"}' "$password" >"$body"
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 20 --cookie-jar "$jar" \
    --header 'Content-Type: application/json' --data "@$body" "$base/api/auth/sign-in/email")
  rm -f "$body"
  [ "$status" = 200 ] || { rm -f "$jar"; fail "the new account did not sign in (status $status)"; }
  status=$(curl --silent --output /dev/null --write-out '%{http_code} %{redirect_url}' --max-time 10 --cookie "$jar" "$base/")
  [[ "$status" == "307 "*"/no-access" ]] || { rm -f "$jar"; fail "the start page did not send the new account to /no-access (got: $status)"; }
  output=$(curl --silent --max-time 10 --write-out ' %{http_code}' --cookie "$jar" "$base/api/runs") ||
    { rm -f "$jar"; fail "GET /api/runs failed as the new account"; }
  rm -f "$jar"
  [ "$output" = '{"error":"no_workspace_access"} 403' ] || fail "the data route did not refuse the new account (got: $output)"
}

require_image() {
  docker image inspect "$1" >/dev/null 2>&1 || fail "image $1 does not exist locally (build it first)"
}

# Runs a command in a throwaway container of the image, with the image's own user.
in_image() {
  local image=$1
  shift
  docker run --rm --entrypoint "$1" "$image" "${@:2}"
}

# CR-17-T07: the image itself configures a numeric non-root user (not just the current process).
assert_image_user_is_numeric_non_root() {
  local image=$1 user uid
  user=$(docker image inspect --format '{{.Config.User}}' "$image")
  uid=${user%%:*}
  [[ "$uid" =~ ^[0-9]+$ ]] || fail "$image sets user '$user', expected a numeric uid"
  [ "$uid" != "0" ] || fail "$image runs as root (user '$user')"
  printf '    image user: %s\n' "$user"
}

# #118-T03: LICENSE, NOTICE and THIRD_PARTY_LICENSES.md of the repository are inside the image under
# /licenses, byte for byte the files of this checkout, readable by the image's own (unprivileged)
# user, and nothing else is in that folder. The image also carries the OCI license label.
# Usage: assert_image_ships_license_files <image>
assert_image_ships_license_files() {
  local image=$1 repo_root file listing label
  repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  for file in LICENSE NOTICE THIRD_PARTY_LICENSES.md; do
    [ -s "$repo_root/$file" ] || fail "$file is missing or empty in the repository"
    in_image "$image" cat "/licenses/$file" 2>/dev/null | cmp -s - "$repo_root/$file" ||
      fail "/licenses/$file is missing in $image, unreadable for its user, or differs from $file of the repository"
  done
  listing=$(in_image "$image" ls /licenses | tr '\n' ' ')
  [ "$listing" = "LICENSE NOTICE THIRD_PARTY_LICENSES.md " ] ||
    fail "/licenses in $image holds '$listing', expected exactly LICENSE, NOTICE and THIRD_PARTY_LICENSES.md"
  label=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.licenses"}}' "$image")
  [ "$label" = "Apache-2.0" ] ||
    fail "$image has the label org.opencontainers.image.licenses='$label', expected Apache-2.0"
  printf '    /licenses: LICENSE, NOTICE, THIRD_PARTY_LICENSES.md; label licenses=%s\n' "$label"
}

# Runs a scan command in a throwaway root container of the image (root, so that no file is hidden
# by a permission error) and puts its standard output into SCAN_OUTPUT. The scan itself must
# succeed: the smoke test stops unless the exit status is one of the allowed ones (a space
# separated list). A scan that fails to run must never look like a scan that found nothing.
# Usage: scan_in_image <image> "<allowed statuses>" <command> [args...]
SCAN_OUTPUT=""
scan_in_image() {
  local image=$1 allowed=$2 status stderr_file
  shift 2
  stderr_file=$(mktemp)
  if SCAN_OUTPUT=$(docker run --rm --user 0 --entrypoint "$1" "$image" "${@:2}" 2>"$stderr_file"); then
    status=0
  else
    status=$?
  fi
  if [[ " $allowed " != *" $status "* ]]; then
    cat "$stderr_file" >&2
    rm -f "$stderr_file"
    fail "the scan '$*' failed in $image with exit status $status (allowed: $allowed)"
  fi
  rm -f "$stderr_file"
}

# The key scan, a shell script that runs inside the image (sh -c, with the paths as its argument; they
# may contain globs). Any PEM key header marks a file, except the one harmless shape found in bundled
# libraries: a comparison such as `x.indexOf("-----BEGIN PRIVATE KEY-----")` (jose, which Next.js
# bundles next to better-auth, checks the format of a key that way). Comparisons (the header between two quote characters) are cut out of a
# copy of the file first; the file is reported if any header is left. Every other shape stays
# caught, also a key that was split, joined or encoded (`"-----BEGIN PRIVATE KEY-----"+body`,
# `...-----%0AMII`): the header is the signal, not what follows it. A path that does not exist, or a
# file that cannot be read, fails the scan (it never looks like "nothing found").
readonly KEY_SCAN_SCRIPT='
marker="-----BEGIN [A-Z ]*PRIVATE KEY-----"
hits=$(grep -rIlE -e "$marker" --exclude-dir=node_modules $1)
status=$?
[ "$status" -le 1 ] || exit "$status"
printf "%s\n" "$hits" | while IFS= read -r file; do
  [ -n "$file" ] || continue
  if ! rest=$(sed -E "s/(indexOf|startsWith|includes)\(.$marker.\)//g" "$file"); then
    printf "%s\n" "$file"
    continue
  fi
  if printf "%s\n" "$rest" | grep -qE -e "$marker"; then
    printf "%s\n" "$file"
  fi
done'

# Proves the scan on files made for the purpose, on the machine that runs the smoke test (no Docker
# needed). Run by assert_image_has_no_secrets before it trusts the scan, and on its own by
# docker/smoke/test-key-scan.sh.
assert_key_scan_works() {
  local dir out
  dir=$(mktemp -d)
  printf -- '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----\n' >"$dir/pem.pem"
  printf -- '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n' >"$dir/rsa.txt"
  printf -- '{"key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkq\\n-----END PRIVATE KEY-----"}\n' >"$dir/json.json"
  printf -- '%s\n' '["-----BEGIN PRIVATE KEY-----","MIIEvQIBADANBgkq"].join("\n")' >"$dir/join.js"
  printf -- '%s\n' 'const k="-----BEGIN PRIVATE KEY-----"+body;' >"$dir/concat.js"
  printf -- '%s\n' 'const k="-----BEGIN PRIVATE KEY-----%0AMIIEvQIBADANBgkq";' >"$dir/encoded.js"
  printf -- '%s\n' 'async function L(a){if("string"!=typeof a||0!==a.indexOf("-----BEGIN PRIVATE KEY-----"))throw TypeError("pkcs8")}' >"$dir/jose.js"
  printf -- '%s\n' "a.startsWith('-----BEGIN RSA PRIVATE KEY-----')||a.includes(\`-----BEGIN PRIVATE KEY-----\`)" >"$dir/other-comparisons.js"
  printf -- '%s\n' 'x.indexOf("-----BEGIN PRIVATE KEY-----");const k="-----BEGIN PRIVATE KEY-----\\nMII";' >"$dir/comparison-and-key.js"
  printf 'nothing to see here\n' >"$dir/clean.txt"
  out=$(sh -c "$KEY_SCAN_SCRIPT" sh "$dir") || fail "the key scan failed to run on its own test files"
  out=$(printf '%s\n' "$out" | sed "s#^$dir/##" | sort | tr '\n' ' ')
  local expected="comparison-and-key.js concat.js encoded.js join.js json.json pem.pem rsa.txt "
  [ "$out" = "$expected" ] || fail "the key scan is wrong: it reported '$out', expected '$expected'"
  if sh -c "$KEY_SCAN_SCRIPT" sh "$dir/does-not-exist" >/dev/null 2>&1; then
    fail "the key scan accepted a path that does not exist"
  fi
  rm -rf "$dir"
}

# CR-17-T09: nothing that must stay out of an image is inside it, and its configuration and build
# history carry no secrets. This is the proof that the ignore files (Dockerfile.dockerignore) work.
# Usage: assert_image_has_no_secrets <image> "<paths of our own files for the key content scan>"
# The paths are the places that hold project-owned files (application directory, data, home
# directories, the project's own Python package). Third-party packages (node_modules,
# site-packages) are left out on purpose: their documentation and test fixtures legitimately
# contain key headers. A path that does not exist makes the scan fail, which keeps the list honest.
assert_image_has_no_secrets() {
  local image=$1 content_paths=$2
  # The operating system's CA bundles (public root certificates, also certifi's cacert.pem) are
  # expected, and so are two public files that third-party packages of the runner ship (a public
  # key of LiteLLM and the root certificates of gRPC); anything else with a key or certificate
  # extension is not. find must exit 0.
  scan_in_image "$image" "0" find / -xdev \
    \( -path /etc/ssl -o -path /usr/lib/ssl -o -path /usr/share/ca-certificates \) -prune -o \
    \( -name '.env' -o -name '.env.*' -o -name '.git' -o -name '*.pem' -o -name '*.p12' \
    -o -name '*.pfx' -o -name '*.key' -o -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \
    -o -name 'id_rsa*' -o -name 'id_ed25519*' \) ! -name cacert.pem \
    ! -path '*/site-packages/litellm/proxy/auth/public_key.pem' \
    ! -path '*/site-packages/grpc/_cython/_credentials/roots.pem' -print
  [ -z "$SCAN_OUTPUT" ] || fail "$image contains files that must not be in an image:
$SCAN_OUTPUT"

  assert_key_scan_works
  scan_in_image "$image" "0" sh -c "$KEY_SCAN_SCRIPT" sh "$content_paths"
  [ -z "$SCAN_OUTPUT" ] || fail "$image contains private key material:
$SCAN_OUTPUT"

  local config history
  config=$(docker image inspect --format '{{json .Config.Env}} {{json .Config.Labels}} {{json .Config.Cmd}} {{json .Config.Entrypoint}}' "$image")
  history=$(docker history --no-trunc --format '{{.CreatedBy}}' "$image")
  # Names that would indicate a secret baked in through ENV, ARG or a RUN line.
  if grep -Eiq '(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)[A-Za-z_]*=' <<<"$config"; then
    fail "$image configuration (ENV, labels, command) carries a secret-looking variable"
  fi
  if grep -Eiq '(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)[A-Za-z_]*=|--build-arg|\|[0-9]+ [A-Za-z_]+=' <<<"$history"; then
    fail "$image build history carries a secret-looking variable or a build argument"
  fi
  printf '    no env files, git data, keys or secrets found\n'
}
