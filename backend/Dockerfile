# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
RUN --mount=type=cache,id=concord-backend-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --config.node-linker=hoisted \
    --store-dir=/pnpm/store --registry="$NPM_REGISTRY" \
    --network-concurrency=4 --fetch-timeout=300000 --fetch-retries=5 \
    --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=60000
COPY tsconfig.json build.mjs ./
COPY src ./src
RUN npm run build

FROM build AS test
COPY migrations ./migrations
COPY test ./test
CMD ["node", "--import", "tsx", "--test", "--test-force-exit", "--test-concurrency=1", "test/*.test.ts"]

FROM build AS production-dependencies
RUN --mount=type=cache,id=concord-backend-pnpm,target=/pnpm/store \
    pnpm prune --prod --ignore-scripts --config.node-linker=hoisted --store-dir=/pnpm/store \
    --registry="$NPM_REGISTRY" --network-concurrency=4 --fetch-timeout=300000 --fetch-retries=5

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# Uploaded files (mounted as a Docker volume; ownership is copied into a fresh volume).
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
