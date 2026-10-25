FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm patches (the Colyseus HTTP adapter fix) must be present before any install.
COPY patches ./patches
COPY packages/server/package.json ./packages/server/package.json
COPY packages/client/package.json ./packages/client/package.json
COPY packages/shared/package.json ./packages/shared/package.json

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY packages ./packages
RUN pnpm build

FROM base AS production-deps
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter @wd/server...

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV GAME_PORT=2567
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=production-deps --chown=node:node /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=production-deps --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=base --chown=node:node /app/package.json ./package.json
COPY --from=base --chown=node:node /app/packages/server/package.json ./packages/server/package.json
COPY --from=base --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/server/dist ./packages/server/dist
COPY --from=build --chown=node:node /app/packages/client/dist ./packages/client/dist
USER node
EXPOSE 2567
CMD ["node", "packages/server/dist/main.js"]
