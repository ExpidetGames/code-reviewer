#!/usr/bin/env bash
# Smoke test of the runner image. Usage: docker/smoke/runner.sh <image>   (default: code-reviewer-runner:local)
#
# The runner has no job loop yet (CR-29); today its entry point answers --version. The test proves
# that the image starts, runs unprivileged, can write to its temporary directory and holds nothing
# that must stay out of an image. PR-Agent checks (installed version, a job through the fake
# PR-Agent) arrive with CR-10 and CR-29.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$here/../.." && pwd)
# shellcheck source=docker/smoke/lib.sh
source "$here/lib.sh"

image=${1:-code-reviewer-runner:local}
require_image "$image"

step "the entry point answers --version with the project version"
expected=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$repo_root/runner/pyproject.toml" | head -n 1)
[ -n "$expected" ] || fail "cannot read the version from runner/pyproject.toml"
output=$(docker run --rm "$image" --version)
[ "$output" = "code-reviewer-runner $expected" ] ||
  fail "expected 'code-reviewer-runner $expected', got '$output'"
printf '    %s\n' "$output"

# CR-17-T07
step "the image sets a numeric non-root user"
assert_image_user_is_numeric_non_root "$image"

step "the process of the entry point runs as a non-root user"
# The entry point exits at once, so the same image user is asked from inside a container.
uid=$(in_image "$image" id -u)
[[ "$uid" =~ ^[0-9]+$ ]] && [ "$uid" != "0" ] || fail "a process in the image runs with uid '$uid'"
printf '    process uid: %s\n' "$uid"

# CR-17-T05 (partly): jobs work in the temporary directory and the home directory.
step "the unprivileged user can write to the temporary and home directories"
in_image "$image" sh -c 'touch /tmp/smoke-write && touch "$HOME/smoke-write"' ||
  fail "the unprivileged user cannot write to /tmp or its home directory"

# CR-17-T09
step "the image holds no environment files, git data, keys or secrets"
assert_image_has_no_secrets "$image"
leftovers=$(in_image "$image" find /opt/venv /home -name 'tests' -o -name 'test_*.py' -o -name '.venv' | grep -v '/site-packages/' || true)
[ -z "$leftovers" ] || fail "tests are inside the image:
$leftovers"

step "runner image smoke test passed"
