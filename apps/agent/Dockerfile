FROM node:24-bookworm-slim AS build
COPY --from=oven/bun:1.3.12 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace
COPY . .
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:1/build
RUN bun install --frozen-lockfile
RUN bun run --filter=agent build -- --skip-sandbox-prewarm
RUN mkdir -p /workspace/workflow-bootstrap/dist /workspace/workflow-bootstrap/src/drizzle \
    && bun build apps/agent/node_modules/@workflow/world-postgres/dist/cli.js --target=bun --packages=bundle --outfile=/workspace/workflow-bootstrap/dist/cli.js \
    && cp -R apps/agent/node_modules/@workflow/world-postgres/src/drizzle/migrations /workspace/workflow-bootstrap/src/drizzle/

FROM node:24-bookworm-slim AS runtime
COPY --from=oven/bun:1.3.12 /usr/local/bin/bun /usr/local/bin/bun
ENV NODE_ENV=production
ENV PORT=2000
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/agent/.output ./.output
COPY --from=build --chown=node:node /workspace/workflow-bootstrap /workspace/workflow-bootstrap
COPY --chown=node:node ops/workflow-bootstrap.sh /app/ops/workflow-bootstrap.sh
USER node
EXPOSE 2000
CMD ["node", ".output/server/index.mjs"]
