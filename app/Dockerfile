# syntax=docker/dockerfile:1
#
# Image of the Code Reviewer web app (Next.js 16, standalone output).
# Build context: the app/ folder:  docker build -t code-reviewer-app app
#
# Base image: Debian bookworm slim for every stage. better-sqlite3 is a native module; the binary
# built or downloaded in the build stage only loads in a runtime with the same libc, so the two
# must stay on the same distribution family (do not switch one stage to Alpine/musl alone). The Node
# major version must match ../.nvmrc (a test checks it). To update the pinned digest:
#   docker pull node:24-bookworm-slim && docker image inspect node:24-bookworm-slim --format '{{index .RepoDigests 0}}'
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# ---- deps: install the dependencies from the lockfile (this layer is cached until it changes) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /build
# pnpm comes from the "packageManager" field of package.json (corepack).
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --ignore-scripts: better-sqlite3 ships a prebuilt binary per platform inside its package
# (prebuilds/linux-arm64.node, linux-x64.node, and musl variants; it picks the glibc one here), so
# nothing has to be compiled and the image needs no Python or compiler. Without the flag, pnpm
# runs the package's implicit "node-gyp rebuild" (allowed in pnpm-workspace.yaml for local
# installs), which fails here for lack of a toolchain. The smoke test (docker/smoke/app.sh) proves
# that the binary loads and the database is created.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---- builder: production build with output "standalone" ----
FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# The standalone server serves ./public when it exists; keep the COPY below valid when it does not.
RUN mkdir -p public && pnpm build

# ---- runtime: only the traced standalone server, no source, no dev dependencies ----
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Code Reviewer app" \
      org.opencontainers.image.description="Web app and API of Code Reviewer" \
      org.opencontainers.image.source="https://github.com/ExpidetGames/code-reviewer"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/app.db

# Fixed numeric ids so that volume permissions are predictable. /data is the database directory:
# the app does not create it (a missing mount must not silently start an empty database), and a
# named volume mounted there inherits this owner on first use. For a bind mount, make the host
# directory writable for uid 10001.
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app \
    && mkdir /data \
    && chown app:app /data

WORKDIR /srv/app
COPY --from=builder --chown=root:root /build/.next/standalone ./
COPY --from=builder --chown=root:root /build/.next/static ./.next/static
COPY --from=builder --chown=root:root /build/public ./public

USER 10001:10001
VOLUME /data
EXPOSE 3000
# The start page is the only route that is public today. Switch to /api/health once it exists.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
