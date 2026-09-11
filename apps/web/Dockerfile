FROM node:22-alpine AS build
WORKDIR /app
COPY apps/web/package.json ./
COPY apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/tsconfig.json apps/web/index.html ./
COPY apps/web/src ./src
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /app/dist /srv
COPY ops/Caddyfile /etc/caddy/Caddyfile
