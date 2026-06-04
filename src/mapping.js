'use strict';

const DEFAULT_ENTITY_ID   = 'urn:ngsi-ld:dds:default';
const DEFAULT_ENTITY_TYPE = 'DDS';

/**
 * Derives a URL-safe short name from a DDS endpoint name.
 * Strips the ROS 2 "rt/" prefix, converts slashes/dashes to underscores.
 */
function cleanName(ddsName) {
  let name = ddsName.replace(/^rt\//, '');       // strip ROS 2 topic prefix
  name = name.replace(/[/\-\s]+/g, '_');         // slashes/dashes → underscore
  name = name.replace(/[^a-zA-Z0-9_.~-]/g, ''); // strip anything not URL-safe
  return name || 'unknown';
}

/**
 * Builds the full editor state from:
 *   - discovered DDS items (topics / services / actions)
 *   - an existing config+context loaded for round-trip editing
 *   - global settings (iriBase, domain, etc.)
 */
function buildMapping(discovery, existing, settings) {
  const existingTopics    = existing.mappings.topics    || {};
  const existingServices  = existing.mappings.services  || {};
  const existingActions   = existing.mappings.actions   || {};

  return {
    settings,
    ddsmodule: existing.ddsmodule || makeDefaultDdsmodule(settings),
    rows: {
      topics:   buildRows('topic',   discovery.topics,   existingTopics),
      services: buildRows('service', discovery.services, existingServices),
      actions:  buildRows('action',  discovery.actions,  existingActions),
    },
  };
}

function buildRows(kind, discoveredItems, existingMappings) {
  const rows = [];
  const seen = new Set();

  // Items present in current discovery (may or may not have an existing mapping)
  for (const item of discoveredItems) {
    seen.add(item.name);
    const existing = existingMappings[item.name] || null;
    rows.push(makeRow(kind, item, existing));
  }

  // Items only in the existing config (e.g. stale entries not in current discovery)
  for (const [name, mapping] of Object.entries(existingMappings)) {
    if (seen.has(name)) continue;
    rows.push({
      kind,
      ddsName: name,
      ddsTypeInfo: '(not in current discovery)',
      mapped: true,
      blocklisted: false,
      entityId:   mapping.entityId,
      entityType: mapping.entityType || '',
      attribute:  mapping.attribute,
    });
  }

  return rows;
}

function makeRow(kind, item, existingMapping) {
  const defaultAttr = cleanName(item.name);
  return {
    kind,
    ddsName:     item.name,
    ddsTypeInfo: typeInfo(kind, item),
    mapped:      !!existingMapping,
    blocklisted: false,
    entityId:    (existingMapping && existingMapping.entityId)   || DEFAULT_ENTITY_ID,
    entityType:  (existingMapping && existingMapping.entityType) || DEFAULT_ENTITY_TYPE,
    attribute:   (existingMapping && existingMapping.attribute)  || defaultAttr,
  };
}

function typeInfo(kind, item) {
  if (kind === 'topic')   return item.typeName || '';
  if (kind === 'service') return `req: ${item.requestType}  rep: ${item.replyType}`;
  if (kind === 'action')  return `goal: ${item.goalType}`;
  return '';
}

/** Map every discovered row with its computed defaults (batch / non-interactive mode). */
function applyAutoDefaults(state) {
  for (const kind of ['topics', 'services', 'actions']) {
    for (const row of state.rows[kind]) {
      if (!row.blocklisted) row.mapped = true;
    }
  }
  return state;
}

function makeDefaultDdsmodule(settings) {
  return {
    dds: {
      domain: settings.domain,
      allowlist:  [{ name: '*' }],
      blocklist:  [{ name: 'add_blocked_topics_here' }],
    },
    topics: {
      name: '*',
      qos: { durability: 'TRANSIENT_LOCAL', 'history-depth': 10 },
    },
    ddsenabler: null,
    specs: {
      threads: 12,
      logging: { stdout: false, verbosity: 'info' },
    },
  };
}

module.exports = { buildMapping, applyAutoDefaults, cleanName };
