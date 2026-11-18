# The fast indexer: its only pool input is the categories of the two pool factories. Every pool is
# found from the factories' PoolCreated events and checked against its genesis, as each factory is
# against its own, before it is served (indexer/README.md).
#
# The build stage installs the locked dependencies and bundles the indexer into one file. The
# image keeps that file and libauth, which the bundle loads as a package: libauth instantiates its
# WebAssembly with a top-level await, which a bundle of SolidCash's module cycles cannot carry. No
# other package reaches the image. The bundle holds the code the indexer imports, SolidCash's
# compiler and in-memory chain among it: SolidCash's own modules import both as they load.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# The verifier is a package in this repository, which the install links.
COPY packages/verifier ./packages/verifier
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --ignore-scripts --no-audit --no-fund --fetch-retries=5

COPY tsconfig.json ./
COPY contracts/artifacts ./contracts/artifacts
COPY web/src ./web/src
COPY scripts/lib ./scripts/lib
COPY service/archive.ts ./service/archive.ts
COPY service/verifier ./service/verifier
COPY indexer ./indexer
RUN npx esbuild indexer/main.ts --bundle --platform=node --format=esm --target=node22 \
      --external:@bitauth/libauth --outfile=dist/indexer.mjs --log-level=warning \
      "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# No package manager runs here, so none is kept.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
# It listens on every interface of the container, which nginx reaches over their network; the
# compose file publishes no port.
ENV NODE_ENV=production INDEXER_PORT=8080
COPY --from=build /app/node_modules/@bitauth/libauth ./node_modules/@bitauth/libauth
COPY --from=build /app/dist/indexer.mjs ./indexer.mjs
# The licences and notices of the code the image holds: SolidPool's, and the third-party code's
# (THIRD_PARTY_NOTICES.md, LICENSES/).
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
USER node
EXPOSE 8080
CMD ["node", "indexer.mjs"]
