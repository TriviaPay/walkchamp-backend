FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini zstd postgresql-client \
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
COPY deploy/coolify/worker-entrypoint.sh /usr/local/bin/worker-entrypoint
COPY deploy/coolify/worker-healthcheck.sh /usr/local/bin/worker-healthcheck

RUN chmod +x /usr/local/bin/run-migrations /usr/local/bin/worker-entrypoint /usr/local/bin/worker-healthcheck

ENTRYPOINT ["tini", "--"]
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
