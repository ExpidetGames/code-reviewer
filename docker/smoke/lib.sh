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

# A PEM key header (extended regular expression). Real key material has something after the header:
# the end of the line (a PEM file), or the key itself, which in a bundled string follows as an
# escaped newline. A header that a library only compares against is closed by a quote right away
# (jose, bundled by Next.js, checks `"-----BEGIN PRIVATE KEY-----"`) and holds no key, so it does not count.
readonly PRIVATE_KEY_MARKER='-----BEGIN [A-Z ]*PRIVATE KEY-----($|[[:space:]\\A-Za-z0-9+/])'

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
  # expected; anything else with a key or certificate extension is not. find must exit 0.
  scan_in_image "$image" "0" find / -xdev \
    \( -path /etc/ssl -o -path /usr/lib/ssl -o -path /usr/share/ca-certificates \) -prune -o \
    \( -name '.env' -o -name '.env.*' -o -name '.git' -o -name '*.pem' -o -name '*.p12' \
    -o -name '*.pfx' -o -name '*.key' -o -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \
    -o -name 'id_rsa*' -o -name 'id_ed25519*' \) ! -name cacert.pem -print
  [ -z "$SCAN_OUTPUT" ] || fail "$image contains files that must not be in an image:
$SCAN_OUTPUT"

  # grep exits 0 when it found a file, 1 when it found none, 2 on any error (a missing path).
  scan_in_image "$image" "0 1" sh -c \
    "grep -rIlE -e '$PRIVATE_KEY_MARKER' --exclude-dir=node_modules $content_paths"
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
