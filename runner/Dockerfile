# syntax=docker/dockerfile:1
# SPDX-License-Identifier: Apache-2.0
#
# Image of the Code Reviewer runner (Python, uv). Build context: the repository root, because the
# image also carries LICENSE, NOTICE and THIRD_PARTY_LICENSES.md from there
# (runner/Dockerfile.dockerignore keeps everything else out):
#   docker build -f runner/Dockerfile -t code-reviewer-runner .
#
# Two images come out of this file (#202). The default target, `runtime`, is the PR-Agent-only
# runner and is the LAST stage, so the command above builds it. The `dynamic` target is the same
# runner plus what Dynamic Review needs and a Diff-only installation should not carry (size and
# attack surface): the pinned stock OpenCode (about 186 MB), `nft`, a pinned `rg` and the dedicated
# engine user 10101. Neither image enables anything by itself; compose.dynamic.yml does, for the
# Dynamic one:
#   docker build -f runner/Dockerfile --target dynamic -t code-reviewer-runner-dynamic .
#
# The Python minor version must match .python-version (a test checks it). Update the digests with
#   docker pull python:3.13-slim-bookworm && docker image inspect python:3.13-slim-bookworm --format '{{index .RepoDigests 0}}'
# The uv version should match the one CI uses on the host (.github/workflows/ci.yml, setup-uv).
ARG PYTHON_IMAGE=python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.0@sha256:cdc6093146eb3ff6a40107b38f008b789e050e77ad87865e381d9917da55a168

FROM ${UV_IMAGE} AS uv

# ---- licenses: the license files of the repository, copied into the runtime stage below ----
FROM scratch AS licenses
COPY LICENSE NOTICE THIRD_PARTY_LICENSES.md /

# ---- builder: create the virtual environment from uv.lock ----
FROM ${PYTHON_IMAGE} AS builder
COPY --from=uv /uv /usr/local/bin/uv
# Use the interpreter of this image (never download one) and compile bytecode once, at build time.
# The venv is created at the path it has in the runtime stage: a venv cannot be moved, its scripts
# contain absolute paths.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON_PREFERENCE=only-system \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
WORKDIR /build
# Dependencies first (cached until pyproject.toml or uv.lock change): PR-Agent and everything it
# pins, installed from uv.lock. All of them have wheels for this Python version, so no compiler is
# needed in this stage.
COPY runner/pyproject.toml runner/uv.lock runner/.python-version ./
RUN uv sync --locked --no-dev --no-install-project
# Then the project itself, installed non-editable so the venv is self-contained.
COPY runner/src ./src
RUN uv sync --locked --no-dev --no-editable
# PR-Agent counts tokens with tiktoken, which downloads its encodings from the internet on first
# use. Download them once here, so a job never needs that connection (and parallel jobs do not race
# to write the same cache). The variable name is tiktoken's second choice; the first choice
# (TIKTOKEN_CACHE_DIR) would trip the secret scan of the image smoke test.
ENV DATA_GYM_CACHE_DIR=/opt/bpe-cache
RUN mkdir -p "$DATA_GYM_CACHE_DIR" \
    && /opt/venv/bin/python -c "import tiktoken; tiktoken.get_encoding('o200k_base'); tiktoken.get_encoding('cl100k_base')"

# ---- engine-tools: the pinned OpenCode and ripgrep, verified, for the dynamic target only ----
# The one build step with the internet besides the dependency install. Both scripts accept a
# download only with the pinned size and SHA-256 (runner/opencode-pin.json, runner/ripgrep-pin.json),
# unpack only the one pinned file and check the version it reports. The scripts find their pin
# one directory above them. Nothing at run time downloads anything.
# Only linux-x64 is pinned. On another platform (an arm64 build server) `--allow-unpinned-platform`
# makes the scripts install nothing and exit 0, so the image still builds: it has no engine, the
# runner's self-check reports the missing engine and it serves Diff jobs only (#264). Without the
# flag a missing pin is an error, as everywhere else the scripts are used.
FROM ${PYTHON_IMAGE} AS engine-tools
COPY runner/scripts/fetch_opencode.py runner/scripts/fetch_ripgrep.py /fetch/scripts/
COPY runner/opencode-pin.json runner/ripgrep-pin.json /fetch/
RUN python /fetch/scripts/fetch_opencode.py --dest /engine-tools --allow-unpinned-platform \
    && python /fetch/scripts/fetch_ripgrep.py --dest /engine-tools --allow-unpinned-platform

# ---- runtime-base: Python, the venv and nothing else (no uv, no compiler, no sources) ----
FROM ${PYTHON_IMAGE} AS runtime-base
LABEL org.opencontainers.image.source="https://github.com/ExpidetGames/code-reviewer" \
      org.opencontainers.image.licenses="Apache-2.0"
# LITELLM_LOCAL_MODEL_COST_MAP makes LiteLLM use its bundled price list instead of fetching it from
# GitHub when it is imported (the runner sets it for every job as well).
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    DATA_GYM_CACHE_DIR=/opt/bpe-cache
# tini is PID 1: the job loop ends the process groups of its jobs, and the helpers it kills are
# re-parented to PID 1, which has to reap them or they stay as zombies. tini also passes SIGTERM on
# to the loop, so a plain `docker stop` is an orderly shutdown without `init: true` in compose.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
# Fixed numeric ids, like the app image. The home directory is writable so tools that cache or
# write config files (PR-Agent, git) work; the job working directories live under /tmp.
RUN groupadd --system --gid 10001 runner \
    && useradd --system --uid 10001 --gid runner --create-home --home-dir /home/runner --shell /usr/sbin/nologin runner
# The license of the project and of its dependencies travel with the image (Apache-2.0, section 4).
# html2text (GPL-3.0) is part of the venv below, with its license text in its dist-info.
COPY --from=licenses / /licenses/
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/bpe-cache /opt/bpe-cache
USER 10001:10001
WORKDIR /home/runner
ENTRYPOINT ["/usr/bin/tini", "--", "code-reviewer-runner"]

# ---- dynamic: the runner plus the engine, for compose.dynamic.yml (#202) ----
# Still starts as the unprivileged user 10001: without the override of compose.dynamic.yml
# (`user: "0:0"` and its capability list) the runner is not the root supervisor, has no engine user
# configured and serves Diff jobs only. What this stage adds is installed root-owned and not
# writable by anyone else; the runner's startup self-check hashes both executables against the pins
# that travel with them (dynamic_review/self_check.py) before it advertises `opencode`.
FROM runtime-base AS dynamic
LABEL org.opencontainers.image.title="Code Reviewer runner (Dynamic Review)" \
      org.opencontainers.image.description="Worker that runs PR-Agent and, when its self-check passes, the stock OpenCode engine for Dynamic Review"
USER 0:0
# nft installs the engine user's network rules once, at container start (ADR 0003). Debian's signed
# package, NOT version-pinned (like tini): apt takes the version the Debian repository has when the
# image is built, so two builds on different days can differ even on the same base image digest. A
# `nftables=<version>` pin would not make it reproducible: the Debian mirrors drop superseded
# versions, so the build would break at the next point release instead.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends nftables \
    && rm -rf /var/lib/apt/lists/*
# The dedicated engine user: its own numeric ids, distinct from the Diff job user 10001, no home
# directory, no shell, no supplementary group. The runner gives the engine a home per job.
RUN groupadd --system --gid 10101 engine \
    && useradd --system --uid 10101 --gid engine --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin engine
# The directory, so that the build also works where the stage above installed nothing (no pin).
COPY --from=engine-tools --chown=0:0 --chmod=0755 /engine-tools/ /usr/local/bin/
# The directory first: COPY would create it with the mode given to the files (0644, not enterable).
RUN install -d -m 0755 -o 0 -g 0 /opt/code-reviewer/pins
COPY --chown=0:0 --chmod=0644 runner/opencode-pin.json runner/ripgrep-pin.json /opt/code-reviewer/pins/
USER 10001:10001

# ---- runtime: the default target, PR-Agent only (the last stage, so a plain build gives it) ----
FROM runtime-base AS runtime
LABEL org.opencontainers.image.title="Code Reviewer runner" \
      org.opencontainers.image.description="Worker that runs PR-Agent for Code Reviewer"
