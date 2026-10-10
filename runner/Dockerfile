# syntax=docker/dockerfile:1
#
# Image of the Code Reviewer runner (Python, uv). Build context: the runner/ folder:
#   docker build -t code-reviewer-runner runner
#
# The Python minor version must match .python-version (a test checks it). Update the digests with
#   docker pull python:3.13-slim-bookworm && docker image inspect python:3.13-slim-bookworm --format '{{index .RepoDigests 0}}'
# The uv version should match the one CI uses on the host (.github/workflows/ci.yml, setup-uv).
ARG PYTHON_IMAGE=python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.0@sha256:cdc6093146eb3ff6a40107b38f008b789e050e77ad87865e381d9917da55a168

FROM ${UV_IMAGE} AS uv

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
# Dependencies first (cached until pyproject.toml or uv.lock change). The runner has no runtime
# dependencies yet. CR-10 adds PR-Agent as a dependency in pyproject.toml, pinned in uv.lock: it is
# installed here from the lockfile without any change to this file. If PR-Agent needs system
# packages (git, build tools for a wheel), install them in this stage and, for runtime libraries
# and the git binary, in the runtime stage below.
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --locked --no-dev --no-install-project
# Then the project itself, installed non-editable so the venv is self-contained.
COPY src ./src
RUN uv sync --locked --no-dev --no-editable

# ---- runtime: Python, the venv and nothing else (no uv, no compiler, no sources) ----
FROM ${PYTHON_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Code Reviewer runner" \
      org.opencontainers.image.description="Worker that runs PR-Agent for Code Reviewer" \
      org.opencontainers.image.source="https://github.com/ExpidetGames/code-reviewer"
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
# Fixed numeric ids, like the app image. The home directory is writable so tools that cache or
# write config files (PR-Agent, git) work; the job working directories live under /tmp.
RUN groupadd --system --gid 10001 runner \
    && useradd --system --uid 10001 --gid runner --create-home --home-dir /home/runner --shell /usr/sbin/nologin runner
COPY --from=builder /opt/venv /opt/venv
USER 10001:10001
WORKDIR /home/runner
ENTRYPOINT ["code-reviewer-runner"]
