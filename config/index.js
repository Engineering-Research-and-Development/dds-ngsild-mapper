module.exports = {
  discovery: {
    url:       process.env.DDS_DISCOVERY_URL            || null,
    localFile: process.env.DDS_DISCOVERY_FILE           || null,
    timeoutMs: process.env.DDS_DISCOVERY_TIMEOUT_MS     || 10000,
  },

  dds: {
    domain:      process.env.DDS_DOMAIN                 || 0,
    typesDir:    process.env.DDS_TYPES_DIR              || '/opt/dds/types',
    syncTimeout: process.env.DDS_SYNC_TIMEOUT_MS        || 5000,
  },

  ngsi: {
    iriBase:    process.env.NGSI_IRI_BASE               || 'https://example.org/dds/',
    contextUri: process.env.NGSI_CONTEXT_URI            || null,
  },

  output: {
    configFile:  process.env.OUTPUT_CONFIG_FILE         || 'out/dds-config.json',
    contextFile: process.env.OUTPUT_CONTEXT_FILE        || 'out/dds-context.jsonld',
  },

  mode: process.env.MAPPER_MODE                         || 'interactive',
};
