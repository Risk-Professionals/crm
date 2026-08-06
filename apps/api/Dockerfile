FROM node:24-bookworm-slim AS build
COPY --from=oven/bun:1.3.12 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace
COPY . .
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:1/build
RUN bun install --frozen-lockfile
RUN bun run --filter=api build

FROM node:24-bookworm-slim AS runtime
COPY --from=oven/bun:1.3.12 /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/bun.lock ./bun.lock
COPY --from=build --chown=node:node /workspace/turbo.json ./turbo.json
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/packages ./packages
COPY --from=build --chown=node:node /workspace/apps/api ./apps/api
COPY --chown=node:node ops/prisma-migrate.sh ops/graph-sync.sh /app/ops/
RUN mkdir -p /workspace/.turbo && chown node:node /workspace/.turbo
USER node
EXPOSE 3001
CMD ["bun", "apps/api/dist/main.js"]
