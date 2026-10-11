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
      org.opencontainers.image.source="https://github.com/ExpidetGames/code-reviewer" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/app.db \
    BACKUP_DIR=/backups

# Fixed numeric ids so that volume permissions are predictable. /data is the database directory:
# the app never creates it itself (a wrong DATABASE_PATH must not silently start an empty database),
# and a named volume mounted there inherits this owner on first use. For a bind mount, make the
# host directory writable for uid 10001. Without any mount, Docker creates an anonymous volume for
# /data (VOLUME below), so the app starts but the data is easy to lose: deployments must mount a
# named volume.
# /backups is where the daily backup goes (BACKUP_DIR). It is a volume of its own, never part of /data:
# a backup that lives with the data is lost with it, and the app refuses such a target. Same rules
# as /data: a named volume inherits this owner, a bind mount must be writable for uid 10001.
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app \
    && mkdir /data /backups \
    && chown app:app /data /backups

WORKDIR /srv/app
COPY --from=builder --chown=root:root /build/.next/standalone ./
COPY --from=builder --chown=root:root /build/.next/static ./.next/static
COPY --from=builder --chown=root:root /build/public ./public
# The backup and restore command line (`node backup/cli.ts backup|restore`, see src/backup/README.md).
# The folder is copied as it is: Node runs the TypeScript files directly, they import nothing of the
# app but better-sqlite3 (resolved from ./node_modules). .dockerignore keeps the tests out.
COPY --from=builder --chown=root:root /build/src/backup ./backup
# The operator's command line (`admin reset-password <email>`, see src/admin-cli/): the same kind of
# folder, with the same two needs.
COPY --from=builder --chown=root:root /build/src/admin-cli ./admin-cli
# Two things the command lines need that the standalone server does not provide: a package.json
# that marks the folder as ES modules (otherwise Node warns about re-parsing every file on every
# run), and better-sqlite3 under its own name (the standalone output keeps it under a hashed name in
# .next/node_modules, for the server only). The ls fails the build if the package is not found.
# `admin` is the short name of the operator's command, on the PATH for `docker compose exec app admin ...`.
RUN echo '{"type":"module"}' > backup/package.json \
    && echo '{"type":"module"}' > admin-cli/package.json \
    && printf '#!/bin/sh\nexec node /srv/app/admin-cli/cli.ts "$@"\n' > /usr/local/bin/admin \
    && chmod 755 /usr/local/bin/admin \
    && cd node_modules \
    && ln -s "$(ls -d .pnpm/better-sqlite3@*/node_modules/better-sqlite3)" better-sqlite3
# The sources stay root-owned and read-only for the app; only the runtime cache (ISR, image
# optimization) is writable.
RUN mkdir -p .next/cache && chown -R app:app .next/cache

USER 10001:10001
VOLUME /data
VOLUME /backups
EXPOSE 3000
# /api/health is public (every other route needs a session) and reads the database.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
