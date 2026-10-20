ARG NODE_IMAGE=node:22-alpine
ARG CADDY_IMAGE=caddy:2-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY apps/web/package.json ./
COPY apps/web/package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN --mount=type=cache,id=voice-collector-npm,target=/root/.npm,sharing=locked \
    npm ci --registry="${NPM_REGISTRY}" --prefer-offline --no-audit --no-fund --update-notifier=false
COPY apps/web/tsconfig.json apps/web/index.html ./
COPY apps/web/src ./src
RUN npm run build

FROM ${CADDY_IMAGE}
COPY --from=build /app/dist /srv
COPY ops/Caddyfile /etc/caddy/Caddyfile
