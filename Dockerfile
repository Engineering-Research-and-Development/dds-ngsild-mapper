# ── Dependency stage ──────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Package metadata first, so the dependency layer is cached across source edits.
COPY package.json package-lock.json ./

# dotenv (.env parsing) and ws (WebSocket discovery) are required at runtime.
RUN npm ci --omit=dev

# ── Runtime image ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# Application code: config/ is required by both entry points, web/ serves the UI.
COPY config/ ./config/
COPY src/    ./src/
COPY web/    ./web/

# Examples — useful for smoke-testing without a live discovery backend.
COPY examples/ ./examples/

RUN chmod +x src/index.js

# Output directory — mount a host volume here to retrieve the generated files:
#   docker run --rm -v $(pwd)/out:/app/out dds-ngsi-mapper
# .cache holds the Smart Data Models catalog; mount it to survive container restarts.
RUN mkdir -p /app/out /app/.cache/sdm && chown -R node:node /app/out /app/.cache

USER node

# Environment defaults (override with -e / --env-file at docker run).
# .env is intentionally NOT copied into the image — pass env vars at runtime.
ENV DDS_DISCOVERY_URL=""
ENV DDS_DISCOVERY_FILE=""
ENV DDS_DISCOVERY_TIMEOUT_MS=10000
ENV DDS_DOMAIN=0
ENV DDS_TYPES_DIR=/opt/dds/types
ENV DDS_SYNC_TIMEOUT_MS=5000
ENV NGSI_IRI_BASE=https://example.org/dds/
ENV NGSI_CONTEXT_URI=""
ENV OUTPUT_CONFIG_FILE=out/dds-config.json
ENV OUTPUT_CONTEXT_FILE=out/dds-context.jsonld
ENV MAPPER_MODE=auto
ENV AUTO_BLOCKLIST_LOGS=true

# Smart Data Models playground (web UI only; set SDM_ENABLED=false when air-gapped).
ENV SDM_ENABLED=true
ENV SDM_CACHE_DIR=.cache/sdm
ENV SDM_CACHE_TTL_MS=86400000
ENV SDM_TIMEOUT_MS=15000

# Web UI port, used only by the server entry point (see below).
ENV WEB_PORT=3000
EXPOSE 3000

ENTRYPOINT ["node", "src/index.js"]

# Default: auto-map from the discovery URL given in the environment.
# Override at runtime, e.g.:
#   docker run --rm \
#     -e DDS_DISCOVERY_URL=http://dds-backend:8080/api/discovery \
#     -e NGSI_IRI_BASE=https://my.org/dds/ \
#     -v $(pwd)/out:/app/out \
#     dds-ngsi-mapper
#
# Use a local snapshot instead of live discovery:
#   docker run --rm \
#     -v $(pwd)/examples:/app/examples \
#     -v $(pwd)/out:/app/out \
#     dds-ngsi-mapper --input examples/discovery.json
#
# Run the browser UI (including the Smart Data Models playground) instead of the CLI:
#   docker run --rm -p 3000:3000 \
#     -v $(pwd)/out:/app/out \
#     --entrypoint node dds-ngsi-mapper src/server.js
CMD []
