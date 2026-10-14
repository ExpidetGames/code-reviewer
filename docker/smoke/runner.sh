#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# Smoke test of the runner image. Usage: docker/smoke/runner.sh <image> [diff|dynamic]
# (defaults: code-reviewer-runner:local, diff). `diff` is the default, PR-Agent-only image and proves
# that it holds nothing of the engine; `dynamic` is the `dynamic` target of runner/Dockerfile and
# proves the engine is the pinned one, runs as its own user, and that the startup self-check
# advertises `opencode` exactly when it should (#202).
#
# The entry point of the image is the job loop (CR-29), which needs a running app, so this test does
# not start it for real; it proves that it refuses to start without its configuration. The test
# proves that the image starts, runs unprivileged, can write to its temporary directory and holds
# nothing that must stay out of an image, and that the pinned PR-Agent is installed and works
# offline: the version equals the pin, its tiktoken encodings are baked in, and a job run through
# the real PR-Agent (no network at all) ends in a well formed failure result without a secret in it.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$here/../.." && pwd)
# shellcheck source=docker/smoke/lib.sh
source "$here/lib.sh"

image=${1:-code-reviewer-runner:local}
mode=${2:-diff}
[ "$mode" = diff ] || [ "$mode" = dynamic ] || fail "unknown mode '$mode' (expected diff or dynamic)"
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

# CR-29: a process that kills its jobs' process groups needs an init process that reaps the orphans.
step "the entry point starts with tini, so killed helpers do not stay as zombies"
entrypoint=$(docker inspect --format '{{json .Config.Entrypoint}}' "$image")
[[ "$entrypoint" == '["/usr/bin/tini","--","code-reviewer-runner"]' ]] ||
  fail "expected tini in front of the job loop, got $entrypoint"
# A job's helpers are killed with their process group and re-parented to PID 1; none may stay a zombie.
zombie_check='
import os, signal, subprocess, time
job = subprocess.Popen(["sh", "-c", "sleep 30 & sleep 30 & wait"], start_new_session=True)
time.sleep(0.5)
os.killpg(job.pid, signal.SIGKILL)
job.wait()
time.sleep(1)
zombies = [d for d in os.listdir("/proc") if d.isdigit()
           and open(f"/proc/{d}/stat").read().rsplit(")", 1)[1].split()[0] == "Z"]
print(len(zombies))
'
zombies=$(docker run --rm --entrypoint /usr/bin/tini "$image" -- python -c "$zombie_check")
[ "$zombies" = "0" ] || fail "$zombies zombie process(es) after ending a process group under tini"

# CR-29: the entry point is the job loop; without its configuration it says so and stops.
step "the job loop refuses to start without its configuration and does not leak the token"
loop_token="smoke-runner-token-0123456789-abcdef-0123456789"
loop_errors=$(docker run --rm -e RUNNER_TOKEN="$loop_token" -e RUNNER_CONCURRENCY=many "$image" 2>&1) && status=0 || status=$?
[ "$status" = "2" ] || fail "the job loop without a URL must exit with 2, got $status"
grep -q "RUNNER_API_URL is required" <<<"$loop_errors" || fail "expected a message about RUNNER_API_URL, got: $loop_errors"
if grep -qF "$loop_token" <<<"$loop_errors"; then fail "the runner token is in the output of the job loop"; fi
printf '    %s\n' "$loop_errors"

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

# #202 (follow-up of #198): the Dynamic Review prompt files and the license notices are package data of
# the installed (non-editable) runner, so the image has them without the repository checkout.
step "the installed runner package carries the Dynamic Review prompts and the license notices"
in_image "$image" python -c "
from importlib.resources import files
package = files('code_reviewer_runner')
required = (
    'dynamic_review/review-skill.md',
    'dynamic_review/prompt_core.py',
    'licenses/LICENSE',
    'licenses/NOTICE',
    'licenses/THIRD_PARTY_LICENSES.md',
)
missing = [name for name in required if not package.joinpath(name).is_file()]
assert not missing, missing" ||
  fail "the installed runner package is missing a Dynamic Review prompt file or a license notice"

# CR-17-T07
step "the image sets a numeric non-root user"
assert_image_user_is_numeric_non_root "$image"

# #118-T03
step "the image ships the license files and carries the license label"
assert_image_ships_license_files "$image"

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

# ---- #202: what the image holds of the engine, and what the startup self-check says ----------------

# The log of a detached runner container, waited for until a line matches. Fails with the log.
# Usage: wait_for_log <container> <extended regex> <seconds>
wait_for_log() {
  local container=$1 pattern=$2 seconds=$3 waited=0
  until docker logs "$container" 2>&1 | grep -Eq -e "$pattern"; do
    [ "$waited" -lt "$seconds" ] || {
      docker logs "$container" >&2 || true
      fail "$container did not log '$pattern' within ${seconds}s"
    }
    sleep 1
    waited=$((waited + 1))
  done
}

# Starts the runner loop detached with no network at all (the app is an address nothing answers on),
# so it only gets as far as its startup and its first, refused, claim.
# Usage: start_loop <container> <docker run arguments...>   (the image is added)
loop_token="smoke-runner-token-0123456789-abcdef-0123456789"
start_loop() {
  local name=$1
  shift
  CLEANUP_CONTAINERS+=("$name")
  docker run --detach --name "$name" --network none \
    --env RUNNER_API_URL=http://127.0.0.1:9 --env RUNNER_TOKEN="$loop_token" \
    --env RUNNER_POLL_INTERVAL_SECONDS=1 "$@" "$image" >/dev/null
}

assert_no_token_in_log() {
  if docker logs "$1" 2>&1 | grep -qF "$loop_token"; then fail "the runner token is in the log of $1"; fi
}

# The default user of both images: nothing makes the runner a Dynamic runner by itself.
step "a runner started with the image's own settings serves Diff jobs only and says why"
start_loop smoke-runner-default
wait_for_log smoke-runner-default 'serves Diff jobs only \(not_a_dynamic_runner\)' 60
if docker logs smoke-runner-default 2>&1 | grep -q "opencode is advertised"; then
  fail "a runner without Dynamic configuration advertised opencode"
fi
assert_no_token_in_log smoke-runner-default
docker rm --force smoke-runner-default >/dev/null

step "the image sets no variable that enables Dynamic Review"
image_env=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image")
if grep -Eq '^(RUNNER_DYNAMIC|RUNNER_OPENCODE|RUNNER_ADVERTISED|RUNNER_DIFF_JOB_USER)' <<<"$image_env"; then
  fail "the image sets a Dynamic variable: $(grep -E '^RUNNER_' <<<"$image_env")"
fi

if [ "$mode" = diff ]; then
  # #202-T03: the default image is the PR-Agent-only runner.
  step "the default image holds no engine, no ripgrep, no nft and no engine user"
  scan_in_image "$image" "0" sh -c \
    'for path in /usr/local/bin/opencode /usr/local/bin/rg /usr/sbin/nft /sbin/nft /usr/bin/nft /opt/code-reviewer; do [ ! -e "$path" ] || echo "$path"; done; getent passwd 10101 || true; getent group 10101 || true'
  [ -z "$SCAN_OUTPUT" ] || fail "the default image holds parts of the Dynamic engine:
$SCAN_OUTPUT"
  step "runner image smoke test passed (diff)"
  exit 0
fi

# ---- the dynamic image ---------------------------------------------------------------------------

# A value of a pin file, read on the host: <file> <key>...
pin_value() {
  python3 -I -c 'import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
for key in sys.argv[2:]:
    value = value[key]
print(value)' "$@"
}

opencode_pin="$repo_root/runner/opencode-pin.json"
ripgrep_pin="$repo_root/runner/ripgrep-pin.json"

# #202-T01: the exact pinned artifacts, root-owned and not writable by anyone else.
for tool in opencode:"$opencode_pin" rg:"$ripgrep_pin"; do
  name=${tool%%:*}
  pin=${tool#*:}
  step "$name in the image is the pinned executable, owned by root and not writable by others"
  expected_sha=$(pin_value "$pin" platforms linux-x64 executableSha256)
  expected_bytes=$(pin_value "$pin" platforms linux-x64 executableBytes)
  actual_sha=$(in_image "$image" sha256sum "/usr/local/bin/$name" | cut -d ' ' -f 1)
  [ "$actual_sha" = "$expected_sha" ] || fail "/usr/local/bin/$name has SHA-256 $actual_sha, the pin says $expected_sha"
  facts=$(in_image "$image" stat -c '%u:%g %a %s %F' "/usr/local/bin/$name")
  [ "$facts" = "0:0 755 $expected_bytes regular file" ] || fail "/usr/local/bin/$name is '$facts', expected '0:0 755 $expected_bytes regular file'"
  in_image "$image" cat "/opt/code-reviewer/pins/$(basename "$pin")" | cmp -s - "$pin" ||
    fail "the pin file in the image differs from $(basename "$pin")"
  printf '    %s  %s\n' "$actual_sha" "$name"
done

# #202-T01: offline, as the engine user, with no network at all.
step "opencode reports the pinned version as the engine user, offline"
pinned_version=$(pin_value "$opencode_pin" version)
reported=$(docker run --rm --network none --user 10101:10101 --env HOME=/tmp --env NO_COLOR=1 \
  --entrypoint /usr/local/bin/opencode "$image" --version) || fail "opencode --version failed as the engine user"
[ "$reported" = "$pinned_version" ] || fail "opencode reports '$reported', the pin says '$pinned_version'"
printf '    opencode %s\n' "$reported"

step "rg reports the pinned version"
rg_version=$(pin_value "$ripgrep_pin" version)
rg_output=$(docker run --rm --network none --user 10101:10101 --entrypoint /usr/local/bin/rg "$image" --version)
rg_reported=${rg_output%%$'\n'*}
[[ "$rg_reported" == "ripgrep $rg_version"* ]] || fail "rg reports '$rg_reported', the pin says $rg_version"

step "nft is installed"
in_image "$image" sh -c 'command -v nft >/dev/null || [ -x /usr/sbin/nft ]' || fail "nft is not installed in the image"

# #202-T01: nothing in the Dynamic image runs with more privilege than in its base image. The base
# image is the one runner/Dockerfile pins (its ARG), measured the same way, so the Debian packages the
# Dynamic target adds (nftables and its libraries) are held to the base image's own set of setuid and
# setgid files (the shadow and util-linux tools), not to a list typed here.
setuid_in_image() {
  docker run --rm --network none --user 0 --entrypoint find "$1" / -xdev -type f \
    \( -perm -4000 -o -perm -2000 \) | sort
}

step "the Dynamic image adds no setuid or setgid file to those of its base image"
base_image=$(sed -n 's/^ARG PYTHON_IMAGE=//p' "$repo_root/runner/Dockerfile")
[ -n "$base_image" ] || fail "no ARG PYTHON_IMAGE in runner/Dockerfile"
base_setuid=$(setuid_in_image "$base_image")
image_setuid=$(setuid_in_image "$image")
added_setuid=$(comm -13 <(printf '%s\n' "$base_setuid") <(printf '%s\n' "$image_setuid"))
[ -z "$added_setuid" ] || fail "the Dynamic image has added setuid or setgid files:
$added_setuid"
printf '    %s setuid or setgid files, all of them in the base image\n' "$(grep -c . <<<"$image_setuid" || true)"

step "the engine user 10101 exists with its own group, no shell and no other group; 10001 stays the Diff user"
[ "$(in_image "$image" id 10101)" = "uid=10101(engine) gid=10101(engine) groups=10101(engine)" ] ||
  fail "unexpected engine user: $(in_image "$image" id 10101)"
in_image "$image" getent passwd 10101 | grep -q ':/usr/sbin/nologin$' || fail "the engine user has a login shell"
[ "$(in_image "$image" id -u runner)" = "10001" ] || fail "the Diff job user is not 10001"

# #202-T01 / #195-T09: the startup self-check, run for real in a container created like the one
# compose.dynamic.yml creates (same user, capabilities, no-new-privileges), without any network.
dynamic_caps=(
  --user 0:0 --cap-drop ALL
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN --cap-add DAC_OVERRIDE
  --cap-add FOWNER --cap-add NET_ADMIN --cap-add SETPCAP
  --security-opt no-new-privileges:true
)
dynamic_env=(--env HOME=/home/runner --env RUNNER_DIFF_JOB_USER=10001:10001)
# #249: the root filesystem is read-only, and the only writable paths are three private tmpfs (the
# `read_only` and `tmpfs` of compose.dynamic.yml; app/src/ci/compose-dynamic.test.ts keeps them equal).
dynamic_rootfs=(
  --read-only
  --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777"
  --tmpfs "/run:rw,noexec,nosuid,nodev,size=1m,mode=0755"
  --tmpfs "/home/runner:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700"
)

step "the self-check of the Dynamic runner passes and opencode is advertised"
start_loop smoke-runner-capable "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}"
wait_for_log smoke-runner-capable 'opencode is advertised' 90
[ "$(docker inspect --format '{{.State.Running}}' smoke-runner-capable)" = true ] || fail "the capable runner stopped"
assert_no_token_in_log smoke-runner-capable

# #249-T01: what a compromised root supervisor can leave behind does not survive a restart. A root
# process inside the container cannot change the tools that run with NET_ADMIN at the next start, and
# what it writes into the three tmpfs is gone after the restart, which runs the self-check again.
step "a restart gives back the same clean container: tools unchanged, tmpfs empty, Docker's /etc files read-only, opencode advertised again"
tools_hash() { docker exec smoke-runner-capable sha256sum /usr/sbin/nft /usr/bin/tini; }
tools_before=$(tools_hash) || fail "cannot hash nft and tini"
docker exec smoke-runner-capable sh -c 'touch /tmp/planted /run/planted /home/runner/planted' ||
  fail "root cannot write to the tmpfs of the container"
# The three files Docker binds into /etc (hosts, hostname, resolv.conf) live in the host's container
# directory and would outlive a restart if root could write them. With `read_only` they are read-only
# too; a root that could append would be a persistence path, so it is checked, not assumed.
docker exec smoke-runner-capable sh -c 'for f in /etc/hosts /etc/hostname /etc/resolv.conf; do [ -f "$f" ] || exit 2; if cat /dev/null >> "$f"; then exit 1; fi; done' 2>/dev/null ||
  fail "root can write to /etc/hosts, /etc/hostname or /etc/resolv.conf, or one of them is missing"
# Exit status 0 only if both files exist and neither can be appended to (a missing path also fails).
docker exec smoke-runner-capable sh -c 'for f in /usr/sbin/nft /usr/bin/tini; do [ -f "$f" ] || exit 2; if cat /dev/null >> "$f"; then exit 1; fi; done' 2>/dev/null ||
  fail "root changed nft or tini on the root filesystem, or one of them is missing"
docker restart smoke-runner-capable >/dev/null
waited=0
until [ "$(docker logs smoke-runner-capable 2>&1 | grep -c 'opencode is advertised')" -ge 2 ]; do
  [ "$waited" -lt 90 ] || { docker logs smoke-runner-capable >&2 || true; fail "opencode was not advertised again after the restart"; }
  sleep 1
  waited=$((waited + 1))
done
docker exec smoke-runner-capable sh -c '[ ! -e /tmp/planted ] && [ ! -e /run/planted ] && [ ! -e /home/runner/planted ]' ||
  fail "a file written into a tmpfs survived the restart"
[ "$(tools_hash)" = "$tools_before" ] || fail "nft or tini differ after the restart"
assert_no_token_in_log smoke-runner-capable
docker rm --force smoke-runner-capable >/dev/null

# #249-T01 / T02: the layout, judged from inside a container created like compose.dynamic.yml creates
# it, by the strongest process of a job: root with its capabilities (DAC_OVERRIDE, CHOWN, FOWNER).
readonly_check='
import errno, os, shutil, subprocess
import code_reviewer_runner

problems = []
paths = [
    shutil.which("nft"), shutil.which("tini"), "/usr/local/bin/opencode", "/usr/local/bin/rg",
    "/opt/code-reviewer/pins/opencode-pin.json", "/opt/code-reviewer/pins/ripgrep-pin.json",
    "/etc/passwd", "/opt/venv/bin/code-reviewer-runner", os.path.realpath(code_reviewer_runner.__file__),
]
for path in paths:
    if not path or not os.path.exists(path):
        problems.append(f"missing: {path}")
        continue
    directory = os.path.dirname(path)
    attempts = {
        "append": lambda: open(path, "ab").close(),
        "chmod": lambda: os.chmod(path, os.stat(path).st_mode),
        "unlink": lambda: os.unlink(path),
        "create next to it": lambda: os.close(os.open(directory + "/.planted", os.O_CREAT | os.O_WRONLY)),
    }
    for what, attempt in attempts.items():
        try:
            attempt()
        except OSError as error:
            if error.errno != errno.EROFS:
                problems.append(f"{path}: {what}: {error}")
        else:
            problems.append(f"{path}: {what} succeeded")
for directory in ("/", "/usr", "/usr/local/bin", "/opt", "/opt/venv", "/etc", "/var", "/home"):
    try:
        os.close(os.open(directory + "/.planted", os.O_CREAT | os.O_WRONLY))
    except OSError as error:
        if error.errno != errno.EROFS:
            problems.append(f"{directory}: create: {error}")
    else:
        problems.append(f"{directory}: create succeeded")

mounts = {}
for line in open("/proc/self/mountinfo"):
    before, _, after = line.partition(" - ")
    fields, rest = before.split(), after.split()
    mounts[fields[4]] = (set(fields[5].split(",")), rest[0], set(rest[2].split(",")))
if "ro" not in mounts["/"][0]:
    problems.append("the root filesystem is not mounted read-only")
# Every other writable mount is a tmpfs of ours or one of Docker itself: the pseudo filesystems, /dev
# and the masked paths under /proc. The files Docker binds into /etc are read-only with read_only.
pseudo = {"proc", "sysfs", "cgroup", "cgroup2", "devpts", "mqueue"}
writable = sorted(
    mountpoint for mountpoint, (options, fstype, _) in mounts.items()
    if "rw" in options and fstype not in pseudo and not mountpoint.startswith("/dev")
    and not mountpoint.startswith(("/proc/", "/sys/"))
)
if writable != ["/home/runner", "/run", "/tmp"]:
    problems.append(f"writable mounts: {writable}")
for mountpoint, owner, mode in (("/tmp", 0, 0o1777), ("/run", 0, 0o755), ("/home/runner", 10001, 0o700)):
    options, fstype, super_options = mounts[mountpoint]
    if fstype != "tmpfs" or not {"noexec", "nosuid", "nodev"} <= options:
        problems.append(f"{mountpoint}: {fstype} {sorted(options)}")
    if not any(option.startswith("size=") for option in super_options):
        problems.append(f"{mountpoint}: no size limit")
    facts = os.stat(mountpoint)
    if (facts.st_uid, facts.st_mode & 0o7777) != (owner, mode):
        problems.append(f"{mountpoint}: owner {facts.st_uid} mode {facts.st_mode & 0o7777:o}")
    path = mountpoint + "/written-by-root"
    with open(path, "w") as stream:
        stream.write("ok")
    os.chmod(path, 0o755)
    try:
        subprocess.run([path], check=False)
    except OSError as error:
        if error.errno != errno.EACCES:
            problems.append(f"{mountpoint}: exec: {error}")
    else:
        problems.append(f"{mountpoint}: a file written there could be executed")
    os.unlink(path)
print("\n".join(problems))
'
step "the root filesystem is read-only: root with its capabilities changes nothing outside the three tmpfs"
problems=$(docker run --rm --network none "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" --entrypoint python "$image" -c "$readonly_check") ||
  fail "the read-only check could not run: $problems"
[ -z "$problems" ] || fail "the root filesystem is not read-only as configured:
$problems"

# #249 (review of #259, minor 1): a Dynamic runner serves Diff jobs as well. One job through the real
# PR-Agent, the way the loop runs it (user 10001, HOME in the tmpfs, working directory in /tmp), in the
# read-only layout: a library or git that writes where nothing is writable fails here, not on the first
# real Diff job. The fake GitHub and LLM are the engine suite's, on the loopback of the host.
step "a Diff job through the real PR-Agent runs in the read-only layout, against the fake GitHub and LLM"
python3 -B "$here/diff_job_fakes.py" "$image" --read-only --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777" ||
  fail "a Diff job does not run in the read-only layout"

# #249-T01: the engine user (and the Diff job user) gain no write path from the layout. The paths a
# user can write in the container, with the settings of compose.dynamic.yml, must be among those it
# can write in the same image without them.
writable_by() {
  local user=$1
  shift
  # find exits non-zero for the directories the user may not enter; only what it prints matters.
  { docker run --rm --network none --user "$user" --workdir / --cap-drop ALL \
    --security-opt no-new-privileges:true "$@" --entrypoint find "$image" / \
    \( -path /proc -o -path /sys \) -prune -o \( -type d -o -type f \) -writable -print 2>/dev/null || true; } | sort
}
for user in 10101:10101 10001:10001; do
  step "user $user can write nowhere that it could not before: the layout adds no write path"
  before=$(writable_by "$user")
  after=$(writable_by "$user" "${dynamic_rootfs[@]}")
  added=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))
  [ -z "$added" ] || fail "the read-only layout lets $user write in addition:
$added"
  printf '    %s\n' "$(tr '\n' ' ' <<<"$after")"
done
step "the engine user can write only in /tmp, besides Docker's own /dev mounts"
engine_writable=$(writable_by 10101:10101 "${dynamic_rootfs[@]}" | grep -vE '^/dev/(shm|mqueue)$' || true)
[ "$engine_writable" = "/tmp" ] || fail "the engine user can write in: $engine_writable"

# #202-T09: each broken prerequisite is "not advertised", with its stable reason, and the runner
# keeps running to serve Diff jobs.
expect_not_advertised() {
  local name=$1 reason=$2
  shift 2
  start_loop "$name" "$@"
  wait_for_log "$name" "opencode is not advertised.*$reason" 90
  if docker logs "$name" 2>&1 | grep -q "opencode is advertised"; then fail "$name advertised opencode ($reason)"; fi
  [ "$(docker inspect --format '{{.State.Running}}' "$name")" = true ] || fail "$name stopped; Diff jobs would no longer be served"
  assert_no_token_in_log "$name"
  docker rm --force "$name" >/dev/null
}

step "without NET_ADMIN the network rules cannot be installed: not advertised"
expect_not_advertised smoke-runner-no-rules network_rules_not_installed \
  --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN \
  --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETPCAP --security-opt no-new-privileges:true \
  "${dynamic_rootfs[@]}" "${dynamic_env[@]}"

step "with an engine user that does not exist: not advertised"
expect_not_advertised smoke-runner-wrong-user engine_user_invalid \
  "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}" --env RUNNER_DYNAMIC_ENGINE_UID=10999 --env RUNNER_DYNAMIC_ENGINE_GID=10999

step "with an engine binary that is not the pinned one: not advertised"
replaced=$(mktemp)
extra_cleanup() { rm -f "$replaced"; }
printf '#!/bin/sh\necho 1.19.0\n' >"$replaced"
chmod 755 "$replaced"
expect_not_advertised smoke-runner-wrong-binary 'engine_binary_(untrusted|checksum_mismatch)' \
  "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}" --volume "$replaced:/usr/local/bin/opencode:ro"

step "runner image smoke test passed"
