FROM node:24-bookworm-slim AS build
COPY --from=oven/bun:1.3.12 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace
COPY . .
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:1/build
RUN bun install --frozen-lockfile
RUN NODE_ENV=production \
    BETTER_AUTH_SECRET=build-only-secret-with-at-least-32-characters \
    ALLOWED_SIGN_IN=build.invalid \
    APP_URL=http://127.0.0.1:3000 \
    API_INTERNAL_URL=http://127.0.0.1:3001 \
    bun run --filter=app build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/app/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/app/.next/static ./apps/app/.next/static
COPY --from=build --chown=node:node /workspace/apps/app/public ./apps/app/public
USER node
EXPOSE 3000
CMD ["node", "apps/app/server.js"]
