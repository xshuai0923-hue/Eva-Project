FROM node:24.16.0-alpine3.22 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.16.0-alpine3.22

# The backup page (#237) dumps and restores the database from here. The client has to be
# the database's own major version (POSTGRES_VERSION): pg_dump refuses a newer server.
# GNU tar reads the archives macOS tar wrote for the release backups.
RUN apk add --no-cache postgresql17-client tar

ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

EXPOSE 8081
CMD ["node", "dist/server.js"]

