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

# CR-17-T09: nothing that must stay out of an image is inside it, and its configuration and build
# history carry no secrets. This is the proof that the .dockerignore files work.
assert_image_has_no_secrets() {
  local image=$1 found
  # The operating system's CA bundles (public root certificates, also certifi's cacert.pem) are
  # expected; anything else with a key or certificate extension is not.
  found=$(in_image "$image" find / -xdev \
    \( -path /etc/ssl -o -path /usr/lib/ssl -o -path /usr/share/ca-certificates \) -prune -o \
    \( -name '.env' -o -name '.env.*' -o -name '.git' -o -name '*.pem' -o -name '*.p12' \
    -o -name '*.pfx' -o -name '*.key' -o -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \
    -o -name 'id_rsa*' -o -name 'id_ed25519*' \) ! -name cacert.pem -print 2>/dev/null) || true
  [ -z "$found" ] || fail "$image contains files that must not be in an image:
$found"

  # Content scan of the places that hold our own files (not the operating system, whose npm or
  # Python documentation mentions the marker in prose).
  found=$(in_image "$image" grep -rIl -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
    /srv /data /home /root /tmp /opt 2>/dev/null) || true
  [ -z "$found" ] || fail "$image contains private key material:
$found"

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
