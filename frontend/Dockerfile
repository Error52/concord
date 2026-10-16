# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
RUN --mount=type=cache,id=concord-frontend-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --config.node-linker=hoisted \
    --store-dir=/pnpm/store --registry="$NPM_REGISTRY" \
    --network-concurrency=4 --fetch-timeout=300000 --fetch-retries=5 \
    --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=60000
COPY tsconfig.json build.mjs index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
