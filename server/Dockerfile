# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f server/Dockerfile .
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server

FROM base AS build
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/prisma ./prisma
RUN ./node_modules/.bin/prisma generate
COPY server/src ./src
COPY server/tsconfig.json server/.env.example ./
# Public build hashes only the inputs declared alongside the generator.
COPY scripts/generate-server-release-metadata.mjs scripts/public-server-inputs.json /app/scripts/
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build

FROM base AS production-deps
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 SKILLHUB_PROFILE=selfhost \
    MEDIA_STORAGE_DIR=/var/lib/skillhub/media SKILL_CARD_STORAGE_DIR=/var/lib/skillhub/cards
COPY --from=production-deps /app/server/node_modules ./node_modules
# Prisma 5's CLI dependency closure is entirely under @prisma (asserted in tests).
COPY --from=build /app/server/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/server/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/server/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/server/package.json /app/server/package-lock.json ./
COPY --from=build /app/server/prisma ./prisma
COPY --from=build /app/server/dist ./dist
COPY deploy/selfhost/entrypoint.sh /usr/local/bin/skillhub-entrypoint
RUN mkdir -p /var/lib/skillhub/media /var/lib/skillhub/cards \
    && chown -R node:node /var/lib/skillhub \
    && chmod 755 /usr/local/bin/skillhub-entrypoint \
    && ln -sf ../prisma/build/index.js node_modules/.bin/prisma \
    && touch .env
VOLUME ["/var/lib/skillhub/media", "/var/lib/skillhub/cards"]
USER node
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/skillhub-entrypoint"]
