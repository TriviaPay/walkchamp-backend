FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini zstd postgresql-client redis-tools \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./db
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY deploy/coolify/run-migrations.sh /usr/local/bin/run-migrations
COPY deploy/coolify/api-entrypoint.sh /usr/local/bin/api-entrypoint
COPY deploy/coolify/ensure-concurrent-indexes.sh /usr/local/bin/ensure-concurrent-indexes
COPY deploy/coolify/worker-entrypoint.sh /usr/local/bin/worker-entrypoint
COPY deploy/coolify/worker-healthcheck.sh /usr/local/bin/worker-healthcheck

RUN chmod +x /usr/local/bin/run-migrations /usr/local/bin/api-entrypoint /usr/local/bin/ensure-concurrent-indexes /usr/local/bin/worker-entrypoint /usr/local/bin/worker-healthcheck

# The runtime never runs npm/npx/corepack (migrations use ./node_modules/.bin/drizzle-kit and
# the app is plain `node`). Dropping them removes the npm CLI's bundled-dependency CVEs (tar,
# sigstore, brace-expansion, ...) flagged by the audit's trivy image scan (§7).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Run as the base image's unprivileged user (audit 2026-08-16 F-05): an RCE inside the container
# must not start as root. /app stays root-owned read-only — the app writes nothing there; the
# worker heartbeat goes to /tmp and migrations talk to Postgres over the network.
USER node

ENTRYPOINT ["tini", "--"]
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
