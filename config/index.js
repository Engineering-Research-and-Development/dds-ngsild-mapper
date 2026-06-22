/** Parse a JSON object from an env var; returns null on empty/invalid. */
function parseJsonEnv(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    console.warn(`Warning: ignoring invalid JSON in env value: ${value}`);
    return null;
  }
}

module.exports = {
  discovery: {
    url:       process.env.DDS_DISCOVERY_URL                        || null,
    localFile: process.env.DDS_DISCOVERY_FILE                       || null,
    timeoutMs: Number(process.env.DDS_DISCOVERY_TIMEOUT_MS)         || 10000,

    // WebSocket-specific discovery options (used when the URL is ws:// or wss://)
    ws: {
      quietWindowMs:    Number(process.env.DDS_DISCOVERY_WS_QUIET_MS) || 1000,
      subscribe:        process.env.DDS_DISCOVERY_WS_SUBSCRIBE        || null,
      settleOnSnapshot: process.env.DDS_DISCOVERY_WS_SETTLE_ON_SNAPSHOT !== 'false',
      verbose:          process.env.DDS_DISCOVERY_WS_VERBOSE === 'true',
      headers:          parseJsonEnv(process.env.DDS_DISCOVERY_WS_HEADERS),
    },
  },

  dds: {
    domain:      Number(process.env.DDS_DOMAIN)                     || 0,
    typesDir:    process.env.DDS_TYPES_DIR                          || '/opt/dds/types',
    syncTimeout: Number(process.env.DDS_SYNC_TIMEOUT_MS)            || 5000,
  },

  ngsi: {
    iriBase:    process.env.NGSI_IRI_BASE               || 'https://example.org/dds/',
    contextUri: process.env.NGSI_CONTEXT_URI            || null,
  },

  output: {
    configFile:  process.env.OUTPUT_CONFIG_FILE         || 'out/dds-config.json',
    contextFile: process.env.OUTPUT_CONTEXT_FILE        || 'out/dds-context.jsonld',
  },

  // Web UI (src/server.js)
  web: {
    port: Number(process.env.WEB_PORT)                  || 3000,
  },

  mode: process.env.MAPPER_MODE                         || 'interactive',
};
