#!/usr/bin/env bash
# Smoke test of the runner image. Usage: docker/smoke/runner.sh <image>   (default: code-reviewer-runner:local)
#
# The runner has no job loop yet (CR-29). The test proves that the image starts, runs unprivileged,
# can write to its temporary directory and holds nothing that must stay out of an image, and that
# the pinned PR-Agent is installed and works offline: the version equals the pin, its tiktoken
# encodings are baked in, and a job run through the real PR-Agent (no network at all) ends in a
# well formed failure result without a secret in it.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$here/../.." && pwd)
# shellcheck source=docker/smoke/lib.sh
source "$here/lib.sh"

image=${1:-code-reviewer-runner:local}
require_image "$image"

# Number of lines in a string (wc pads its output on macOS, hence tr).
line_count() { printf '%s\n' "$1" | wc -l | tr -d ' '; }

step "the entry point answers --version with the project version"
expected=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$repo_root/runner/pyproject.toml" | head -n 1)
[ -n "$expected" ] || fail "cannot read the version from runner/pyproject.toml"
output=$(docker run --rm "$image" --version)
[ "$output" = "code-reviewer-runner $expected" ] ||
  fail "expected 'code-reviewer-runner $expected', got '$output'"
printf '    %s\n' "$output"

# CR-17-T06
step "the installed PR-Agent is the pinned version"
pinned=$(sed -n 's/^ *"pr-agent==\(.*\)",$/\1/p' "$repo_root/runner/pyproject.toml" | head -n 1)
[ -n "$pinned" ] || fail "cannot read the pr-agent pin from runner/pyproject.toml"
installed=$(in_image "$image" python -c "from importlib.metadata import version; print(version('pr-agent'))")
[ "$installed" = "$pinned" ] || fail "pr-agent $installed is installed, runner/pyproject.toml pins $pinned"
printf '    pr-agent %s\n' "$installed"

# CR-10-T03: the identity patch needs this private method; the runner refuses to start without it.
step "PR-Agent imports and still has the method the identity patch replaces"
in_image "$image" python -c "
from pr_agent.git_providers.github_provider import GithubProvider
assert callable(GithubProvider._resolve_user_login)" ||
  fail "PR-Agent does not import or has no GithubProvider._resolve_user_login"

step "the tiktoken encodings are baked into the image (no network needed)"
docker run --rm --network none --entrypoint python "$image" -c \
  "import tiktoken; tiktoken.get_encoding('o200k_base'); tiktoken.get_encoding('cl100k_base')" ||
  fail "tiktoken needs the network: the encodings are not cached in the image"

# CR-10-T04
step "the job entry point refuses an invalid job with one line of JSON"
refused=$(echo '{}' | docker run --rm -i --entrypoint code-reviewer-run-job "$image") && status=0 || status=$?
[ "$status" = "1" ] || fail "an invalid job must exit with 1, got $status"
[ "$(line_count "$refused")" = "1" ] || fail "an invalid job must give one line of output, got: $refused"
grep -q '"errorCode":"invalid_job"' <<<"$refused" || fail "expected invalid_job, got: $refused"

# CR-10-T07: real PR-Agent, no network. The pull request lives on an address nothing listens on, so
# the job fails while PR-Agent creates its GitHub client; the result must say so and carry no secret.
step "a job through the real PR-Agent without network fails cleanly and leaks nothing"
smoke_token="smoke-installation-token-0123456789"
smoke_key="smoke-openrouter-key-0123456789"
job='{"prUrl":"http://127.0.0.1:9/octo/repo/pull/7","command":"review","git":{"provider":"github","baseUrl":"http://127.0.0.1:9/api/v3","token":"'$smoke_token'","botLogin":"code-reviewer"},"llm":{"provider":"openrouter","model":"deepseek/deepseek-chat","apiKey":"'$smoke_key'","baseUrl":"http://127.0.0.1:9/api/v1","maxTokens":32000}}'
errors=$(mktemp)
result=$(docker run --rm -i --network none --entrypoint code-reviewer-run-job "$image" <<<"$job" 2>"$errors") && status=0 || status=$?
[ "$status" = "1" ] || fail "a job without network must exit with 1, got $status: $result"
[ "$(line_count "$result")" = "1" ] || fail "a job must give one line of output, got: $result"
grep -q '"ok":false' <<<"$result" && grep -q '"errorCode":"git_unavailable"' <<<"$result" ||
  fail "unexpected result for a job without network: $result"
if grep -qF -e "$smoke_token" -e "$smoke_key" <<<"$result" || grep -qF -e "$smoke_token" -e "$smoke_key" "$errors"; then
  fail "a secret of the job is in the output of the runner"
fi
rm -f "$errors"
printf '    %s\n' "$result"

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
# shellcheck disable=SC2016 # $HOME must expand inside the container, not here
in_image "$image" sh -c 'touch /tmp/smoke-write && touch "$HOME/smoke-write"' ||
  fail "the unprivileged user cannot write to /tmp or its home directory"

# CR-17-T09
step "the image holds no environment files, git data, keys or secrets"
assert_image_has_no_secrets "$image" "/opt/venv/lib/python*/site-packages/code_reviewer_runner /home /root /tmp"
# Only our own package is checked for tests: third-party packages may ship a tests directory.
scan_in_image "$image" "0" sh -c \
  "find /opt/venv/lib/python*/site-packages/code_reviewer_runner /home -name tests -o -name 'test_*.py' -o -name '*_test.py' -o -name conftest.py"
[ -z "$SCAN_OUTPUT" ] || fail "tests are inside the image:
$SCAN_OUTPUT"
# shellcheck disable=SC2016 # $dir must expand inside the container, not here
scan_in_image "$image" "0" sh -c 'for dir in /build /src /tests; do [ ! -e "$dir" ] || echo "$dir"; done'
[ -z "$SCAN_OUTPUT" ] || fail "build directories are inside the image:
$SCAN_OUTPUT"

step "runner image smoke test passed"
