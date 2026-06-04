# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS base

WORKDIR /app

# Copy package metadata first (layer cache)
COPY package.json ./

# No npm install needed — zero external runtime dependencies
# (all built-in Node modules: fs, http, https, readline, util)

# Copy source
COPY src/ ./src/

# Mark entrypoint executable
RUN chmod +x src/index.js

# ── Runtime image ──────────────────────────────────────────────────────────────
FROM base AS runtime

# Output directory — mount a host volume here to retrieve the generated files:
#   docker run --rm -v $(pwd)/out:/app/out dds-ngsi-mapper
RUN mkdir -p /app/out

# Copy examples (optional — useful for smoke-testing without a live backend)
COPY examples/ ./examples/

# Copy default config and .env template
COPY mapper.config.json ./
# .env is intentionally NOT copied into the image — pass env vars at runtime

# Environment variable defaults (overridable via -e / --env-file at docker run)
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

ENTRYPOINT ["node", "src/index.js"]

# Default: auto-map from the discovery URL in mapper.config.json / env vars.
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
CMD []
