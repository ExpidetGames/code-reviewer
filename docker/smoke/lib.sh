#!/usr/bin/env bash
# Shared helpers of the image smoke tests (docker/smoke/app.sh, docker/smoke/runner.sh). Sourced,
# not executed. The smoke tests need a Docker daemon and fail loudly without one; they never skip.

# Output goes to stderr only for failures; progress lines are plain.
step() { printf '==> %s\n' "$*"; }
fail() {
  printf 'SMOKE TEST FAILED: %s\n' "$*" >&2
  exit 1
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
  return 0
}
trap cleanup EXIT

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
# history carry no secrets. This is the proof that the .dockerignore files work.
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
