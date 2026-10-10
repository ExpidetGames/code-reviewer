# CR-13 spike: memory and duration of one PR-Agent process

Date: 2026-10-10. Everything below was measured with `runner/scripts/measure_runs.py` (wrapper
`measure_child.py`), see "Setup". The raw JSON lines (without the log texts) are in `docs/spike/data/cr-13/`; the memory runs can be repeated with the commands at the end, the real-model runs by nature cannot.

## Result in short

- **One runner process needs about 320 MB peak RSS, for every pull request size** (small, medium and
  large are within 2 MB of each other). The memory is the Python process with PR-Agent, LiteLLM and
  their imports (about 200 MB right after import), not the size of the diff: PR-Agent cuts the diff to
  32,000 tokens.
- Several processes in one container share about 26 MB: the container peak is `26 MB + 295 MB x N`
  (measured: 321, 615, 909, 1203 MB for N = 1 to 4).
- **Default `RUNNER_CONCURRENCY`: 3 for a runner container with 2 GiB**, in general
  `floor((container MiB - 256) / 482)`, which is about 1.5 slots per GiB (table below).
- **Server for Coolify: 8 GB RAM and 4 vCPU recommended.** The budget adds up to 3.9 GB, so 4 GB / 2 vCPU
  fits with `RUNNER_CONCURRENCY=3` on paper, but with no margin on figures that are partly estimates
  (calculation below).
- Duration is dominated by the model: 41 to 176 s (small), 67 to 80 s (medium), 71 to 200 s (large) with
  `deepseek/deepseek-v3.2`; PR-Agent's own part (GitHub requests, diff handling) is 9 to 22 s with CPU
  time of 3 to 4.4 s.

## Setup (CR-13-T01)

| | |
|---|---|
| PR-Agent | 0.47.0, runner `code-reviewer-run-job` (identity patch, comment recorder) |
| Python / image | 3.13, the repository's `runner/Dockerfile` (`code-reviewer-runner`), linux/arm64 |
| Machine | Docker Desktop VM on a Mac: 8 vCPU, 8 GB RAM. Container limit `--memory 2g --memory-swap 2g` (no swap) unless stated. A production x86_64 server may differ by some percent. |
| Model | `deepseek/deepseek-v3.2` via OpenRouter (reasoning effort medium, PR-Agent default of the runner), or the local fake LLM (`--fake-llm`, a canned review) where it says so |
| GitHub | real, `ExpidetGames/code-reviewer-playground`, installation token as in production |
| Memory method | peak RSS of the process: `ru_maxrss` of the waited child (so only that process, not the wrapper), plus the container's `memory.peak` (includes page cache) and `oom_kill` from the cgroup |
| Size classes | small < 50 changed lines: PR #1 (39 additions, 2 deletions, 2 files). Medium about 500 lines: PR #2 (472 additions, 15 files). Large > 2000 lines or > 50 files: PR #3 (3,858 additions, 69 files) |

The tokens of the diffs seen by the model: small 3.0k, medium 7.7k, large 31.5k (the large diff is 37.1k
tokens and is pruned to the 32k limit, see T07).

## Memory (CR-13-T02, T04, T05, T07)

Single process, fake LLM, repeated five times per size in a 2 GiB container, plus the real-model runs
(three per size) which gave the same figures:

| Size | Peak RSS fake LLM (min / median / max, MB) | Peak RSS real model (min / median / max, MB) | CPU time per run |
|---|---|---|---|
| small | 321.3 / 321.3 / 323.2 | 321.2 / 321.4 / 323.1 | 3.0 to 3.1 s |
| medium | 320.3 / 321.2 / 322.1 | 320.4 / 321.4 / 322.2 | 3.0 to 3.3 s |
| large | 320.2 / 320.4 / 320.5 | 320.4 / 320.9 / 321.1 | 3.4 to 4.4 s |

For orientation: the bare interpreter is 28 MB, after `import litellm` and `PRAgent` it is 197 MB.

**Parallel processes, large PR, fake LLM, container limit 4 GiB** (two batches each):

| N at the same time | Container peak (MB) | Peak RSS per process (MB) | Time of the batch |
|---|---|---|---|
| 1 | 321 | 320 | 23 s |
| 2 | 614 / 616 | 320 | 21 to 22 s |
| 3 | 909 / 907 | 320 | 22 s |
| 4 | 1203 / 1207 | 320 to 322 | 22 s |

No slowdown up to N = 4 (8 vCPU; the processes mostly wait). **Where memory runs out** (N = 4, large, fake
LLM): a 1 GiB container kills one process (`SIGKILL`, `oom_kill` = 1, the other three finish); 1.5 GiB and
2 GiB finish all four. So four processes need about 1.2 GB; the first limit that fails is 1 GiB. No swap
was involved (swap disabled), so the failure is an OOM kill, not slowness.

**Diff above the token limit (T07):** the large PR is 37,142 tokens against a limit of 32,000.
PR-Agent logs "pruning diff" and "Too many files in PR, will avoid loading full content for rest of
files", reviews the pruned diff and finishes normally (`ok: true`) with the same 320 MB. A diff far larger
than 37k tokens was not tried (the playground has no such pull request and none was created); the prompt
is bounded by the pruning, but the contents PR-Agent fetches per file are not, so this stays a risk for
the engine suite (CR-41): a fake GitHub with a multi-megabyte diff.

## Duration with the real model (CR-13-T03, T04)

One process at a time, in the container, `deepseek/deepseek-v3.2`. Duration is the runner's `durationMs`
(`measure_runs.py` reports exactly this as `durationSeconds`; the wrapper's wall time is 1 to 2 s longer, it
includes the start of the process and the imports)
(start of the process until the result), in seconds. Small has six runs (three with the pull request as it
was in CR-11 with one line changed, three on the original content), medium and large three each.

| Size | Runs (s) | min / median / max | Tokens in / out | Cost per run |
|---|---|---|---|---|
| small | 67, 176, 61, 41, 49, 43 | 41 / 55 / 176 | 3.0k / 1.6 to 2.6k | 0.002 to 0.005 USD |
| medium | 80, 80, 67 (+ 110 as the single run of T06) | 67 / 80 / 80 | 7.7k / 2.9 to 3.6k | 0.006 to 0.008 USD |
| large | 107, 71, 200 | 71 / 107 / 200 | 31.5k / 1.9 to 3.2k | 0.010 to 0.011 USD |

The spread inside one size (41 to 176 s for the same small pull request) is larger than the difference
between sizes. It is model latency: with the fake LLM the same runs take 9.5 s (small), 13 s (medium) and
22 s (large) in total, i.e. PR-Agent's own work (imports 2.5 s, GitHub requests, diff handling) grows with size and
is small against the model's 30 to 180 s. The memory figures do not depend on it.

## Parallel reviews with the real model (CR-13-T06)

Medium PR, `deepseek/deepseek-v3.2`, N reviews started at the same moment (one batch each):

| N | Duration per review (s) | Container peak (MB) | 429 or errors |
|---|---|---|---|
| 1 | 110 | 321 | none |
| 2 | 57, 85 | 615 | none |
| 3 | 53, 66, 57 | 911 | none |
| 4 | 294, 247, 161, 172 | 1201 | none |

Up to N = 3 nothing changes. The batch of four was much slower (161 to 294 s against 53 to 110 s before).
No 429 or other error appeared in the logs of any run (the runner log keeps warnings and errors; LiteLLM's
silent retries are not visible, so a throttled provider cannot be ruled out). It is one batch per N, so
this is a hint, not a trend: keep an eye on it when raising the concurrency, and cap the concurrency per
installation (GitHub's secondary limits) in the scheduler.

## Default `RUNNER_CONCURRENCY` (CR-13-T08)

```
slots = floor( (container RAM - reserve) / (peak RSS of the large PR x safety factor) )
reserve       = 256 MB   (the runner loop process of CR-29, Python without PR-Agent, plus slack)
peak RSS      = 321 MB   (measured, large PR)
safety factor = 1.5      (other PR-Agent versions, x86_64 vs arm64, larger file contents, glibc)
per slot      = 321 x 1.5 = 482 MB
```

| Runner container RAM | Slots (rounded down) | Expected peak with all slots busy |
|---|---|---|
| 1 GiB | floor((1024 - 256) / 482) = 1 | about 0.32 GB |
| **2 GiB** | floor((2048 - 256) / 482) = **3** | **0.91 GB (measured)** |
| 3 GiB | floor((3072 - 256) / 482) = 5 | about 1.5 GB |
| 4 GiB | floor((4096 - 256) / 482) = 7 | about 2.1 GB |

**Proposal: runner container limit 2 GiB and `RUNNER_CONCURRENCY=3` by default**, about 1.5 slots per GiB
of container RAM. Checked in CR-13-T10 below. Other limits apply before memory does: the model
provider's rate limit (T06 above) and GitHub's secondary limits, so the scheduler should also cap the
jobs per installation (2 is a reasonable start).

## Server recommendation for Coolify (CR-13-T09)

| Part | Budget (GB) | Source |
|---|---|---|
| Operating system | 0.3 | typical idle Debian/Ubuntu server (estimate) |
| Docker engine and containerd | 0.3 | typical (estimate) |
| Coolify (control plane: Coolify, its Postgres and Redis, realtime, proxy) | 1.0 | Coolify's own minimum is 2 GB for a server that also runs apps (docs.coolify.io); about 1 GB is its share (estimate, not measured) |
| App (Next.js standalone + SQLite) | 0.5 | measured: 100 MB RSS idle for today's skeleton (image `code-reviewer-app`, 30 requests); 0.5 reserved for the real app |
| Runner container, 3 slots | 1.0 | measured 0.91 GB peak at 3 busy slots (plus the runner loop) |
| Sum | 3.1 | |
| Headroom 25 % (page cache, spikes, deploys that run two containers at once) | 0.8 | |
| **Total** | **3.9** | |

**Recommendation: 8 GB RAM and 4 vCPU.** The sum above is 3.9 GB, so 4 GB is the calculated minimum and
works with `RUNNER_CONCURRENCY=3`. The reason for 8 GB is margin, not a missing byte: Coolify's 1 GB and the
OS and Docker figures are estimates that were not measured, the app is a skeleton today, and a deploy briefly
runs the old and the new app container side by side. If 4 GB is used anyway, take `RUNNER_CONCURRENCY=2`
and a runner limit of 1.5 GiB for some extra room (saves about 0.5 GB). 4 vCPU because a review needs 3 to 4.4 s of CPU (mostly imports) and Coolify, Docker and the app
need CPU too; the model wait does not. The disk is outside this ticket (images 0.7 GB runner and 0.3 GB app).

## Ten large jobs through the default setting (CR-13-T10)

The job loop (CR-29) does not exist yet, so the wrapper plays the queue: 10 large jobs, at most 3 at the
same time (`--count 10 --concurrency 3`), container limit 2 GiB, fake LLM, real GitHub.

- All 10 jobs ended `ok: true`, container peak 913 MB, `oom_kill` 0, total time 85 s.
- Negative control: the same 10 jobs all at once (`--concurrency 10`) in the same container: 6 of 10 were
  killed (`SIGKILL`, `oom_kill` = 6), peak 2048 MB. This is why the concurrency has to follow the container
  limit.

## Built-in issues found by the real reviews

Counted from the review comments of the reviews above (GitHub keeps the edit history of a comment).
A review shows at most two to three findings. What the issues are is not described here on purpose (this
repository is public): they are called issue A, B and C per pull request, only the hit rates are given.

| Pull request | Reviews counted | Issue A | Issue B | Issue C |
|---|---|---|---|---|
| #1 small (original content) | 3 | found 3 of 3 | found 2 of 3 | n/a (only two issues) |
| #2 medium | 3 in the size runs, 10 more in T06 (13 in all) | found 4 of 13 (2 of the first 3) | found 4 of 13 (0 of the first 3); two reviews also raised a related remark | found 0 of 13 |
| #3 large | 3 | found 3 of 3 | found 3 of 3 | n/a (only two) |

So: all four issues of the small and large pull requests were found in at least one review and
the large PR's two were found every time; the medium PR is where the model is unreliable (issue C was never found, A and B in about a third of the reviews). The findings also change from run to run
(see CR-11). This is a model observation with one model, not a quality benchmark.

PR #1 has the original content again: after CR-11 a revert commit (`b6062f0`) restored the tree of
the branch `pr-small` to commit `ac848ef`. The comments of the three pull requests contain the output of the
last real review (the fake-LLM runs of this ticket briefly wrote a canned finding into them).

## Test cases

| Case | Result |
|---|---|
| T01 | This document: size classes with numbers, setup and method. |
| T02 | Done (Docker, real GitHub, fake LLM): section "Memory". The "GitHub fake" of the case does not exist yet (CR-41); real GitHub was used. |
| T03 | Done manually: section "Duration". |
| T04 | Done: min, median, max for duration and RSS (3 to 6 runs per size). |
| T05 | Done up to N = 4 (container peaks 321, 615, 909, 1203 MB); the first limit that fails: 1 GiB at N = 4. |
| T06 | Done for N = 1 to 4 with the real model, no 429 seen. |
| T07 | Partly: the large PR above the token limit ends normally without OOM; a diff far beyond 37k tokens was not available. |
| T08 | Calculation above. |
| T09 | Calculation above (OS, Docker, Coolify, app, runner listed separately). |
| T10 | Done with the wrapper as the queue (no job loop yet). |

## Commands

```
set -a; . ~/.config/code-reviewer/dev.env; set +a        # the developer's credentials, never printed
docker build -t code-reviewer-runner:measure runner
cd runner
uv run python scripts/measure_runs.py --size large --fake-llm --docker code-reviewer-runner:measure --memory 2g --repeat 5 --yes
uv run python scripts/measure_runs.py --size large --fake-llm --docker code-reviewer-runner:measure --memory 4g --count 4 --yes
uv run python scripts/measure_runs.py --size medium --docker code-reviewer-runner:measure --memory 2g --count 3 --yes   # real model
uv run python scripts/measure_runs.py --size large --fake-llm --docker code-reviewer-runner:measure --memory 2g --count 10 --concurrency 3 --yes
```

App figure (100 MB idle, after 30 requests to `/`; the image is built from `app/` of this branch, the
values are test values for a local container, not secrets):

```
docker build -t code-reviewer-app:measure app
docker volume create crapp-data
docker run -d --rm --name crapp --memory 1g -p 127.0.0.1::3000 -v crapp-data:/data \
  -e BETTER_AUTH_SECRET=dummy-secret-for-memory-measurement-0123456789 -e BETTER_AUTH_URL=http://localhost:3000 \
  -e GITHUB_OAUTH_CLIENT_ID=dummy -e GITHUB_OAUTH_CLIENT_SECRET=dummy code-reviewer-app:measure
for i in $(seq 30); do curl -s -o /dev/null http://127.0.0.1:$(docker port crapp 3000 | head -1 | sed 's/.*://')/; done
docker exec crapp sh -c 'grep VmRSS /proc/1/status; cat /sys/fs/cgroup/memory.peak'
docker stop crapp; docker volume rm crapp-data
```

Notes on the data: runs with `--fake-llm` overwrite the real review comment of the playground pull request with
a canned finding (the real runs afterwards put a real review back), and the `costUsd` in their result is
computed from the fake token counts, not a real cost. Children killed by the out-of-memory killer
(`exitCode` null) are left out of the min/median/max figures of `measure_runs.py` and counted separately; in
this report that only concerns the 1 GiB container with four processes (one killed, 284 MB when it died) and
the negative control with ten at once.

Spend of this ticket: the runner reported 0.1155 USD for the 22 real reviews (0.002 to 0.011 USD each, the
cost PR-Agent computes from the token counts). Taking the spread of the per-run ranges into account the bill
is 0.12 to 0.17 USD; the OpenRouter dashboard was not read.
