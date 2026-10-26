# syntax=docker/dockerfile:1
# One image for both processes: `node dist/server.js` (API) and `node dist/worker.js` (jobs).
# Docker Hub is unreliable from mainland China: override NODE_IMAGE with an Alibaba Container Registry
# mirror and NPM_REGISTRY with https://registry.npmmirror.com when building there.
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=${NPM_REGISTRY}
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
# pg_dump for the nightly db.backup job; tini reaps children and forwards signals.
RUN apk add --no-cache postgresql17-client tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY src/db/migrations ./dist/db/migrations
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
