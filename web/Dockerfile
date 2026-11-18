# The app as it runs behind nginx: Next's standalone server and the files it serves, as `node`, on
# a read-only file system, with no package manager and none of the development packages.
#
#   docker compose --profile chipnet up -d --build      (docker-compose.yml, app-chipnet)
#
# The build stage installs the locked dependencies of the project and of web/, then builds with no
# network at all: the fonts are in the repository, and nothing else may be fetched. A build checks
# the settings' form as every production build does, so the compose file passes them as build
# arguments; it cannot reach the chain servers, so SOLIDPOOL_OFFLINE_BUILD leaves those to the
# start. The server asks them as it starts, from the settings the container runs with, and stops if
# one will not do (web/instrumentation.ts).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/verifier ./packages/verifier
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --ignore-scripts --no-audit --no-fund --fetch-retries=5
COPY web/package.json web/package-lock.json web/.npmrc ./web/
COPY web/engine ./web/engine
COPY web/wallet ./web/wallet
RUN --mount=type=cache,target=/root/.npm cd web && npm ci --prefer-offline --ignore-scripts --no-audit --no-fund --fetch-retries=5

COPY contracts/artifacts ./contracts/artifacts
COPY service/verifier/verifier-artifact-3in.json ./service/verifier/verifier-artifact-3in.json
# The licences and notices the build copies into web/public/licenses/, which the image serves at
# /licenses/ with NOTICE.txt beside them (web/lib/licences.ts).
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
# The server's start check reads its factories' geneses as verify-deployment does (web/lib/factory-check.ts).
COPY scripts/lib ./scripts/lib
COPY web ./web

# Each network's settings under its own names, which the compose file passes for both networks, and
# POOL_NETWORK's under the bare names too, for an image built by hand (web/.env.example).
ARG POOL_NETWORK
ARG MAINNET_TRUSTLESS_FULCRUM_URL
ARG MAINNET_TRUSTLESS_BROADCAST_URL
ARG MAINNET_BCH_FACTORY
ARG MAINNET_TOKEN_FACTORY
ARG MAINNET_INDEXER_URL
ARG CHIPNET_TRUSTLESS_FULCRUM_URL
ARG CHIPNET_TRUSTLESS_BROADCAST_URL
ARG CHIPNET_BCH_FACTORY
ARG CHIPNET_TOKEN_FACTORY
ARG CHIPNET_INDEXER_URL
ARG TRUSTLESS_FULCRUM_URL
ARG TRUSTLESS_BROADCAST_URL
ARG BCH_FACTORY
ARG TOKEN_FACTORY
ARG INDEXER_URL
ARG WALLETCONNECT_PROJECT_ID
ARG SITE_URL
ARG SOURCE_URL
ARG BCMR_SERVICE_URL
ARG WALLETCONNECT_RELAY_URL
ARG NEXT_PUBLIC_CIRCUIT_URL
ARG NEXT_PUBLIC_PROVING_KEY_URL
RUN --network=none cd web && SOLIDPOOL_OFFLINE_BUILD=1 NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next build

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# No package manager runs here, so none is kept.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
# It listens on every interface of the container, which nginx reaches over their network; the
# compose file publishes no port.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8787 HOSTNAME=0.0.0.0
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./web/.next/static
COPY --from=build /app/web/public ./web/public
USER node
EXPOSE 8787
CMD ["node", "web/server.js"]
