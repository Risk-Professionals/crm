FROM node:24-bookworm-slim AS build
COPY --from=oven/bun:1.3.12 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace
COPY . .
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:1/build
RUN bun install --frozen-lockfile
RUN bun run --filter=agent build -- --skip-sandbox-prewarm

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=2000
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/agent/.output ./.output
USER node
EXPOSE 2000
CMD ["node", ".output/server/index.mjs"]
