'use strict';

const fs   = require('fs');
const path = require('path');

/** Load an existing config + optional @context for round-trip editing. */
function loadExisting(configPath, contextPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read config file "${configPath}": ${e.message}`);
  }

  const ngsild = raw?.dds?.ngsild || {};

  const mappings = {
    topics:   ngsild.topics   || {},
    services: ngsild.services || {},
    actions:  ngsild.actions  || {},
  };

  // Derive settings saved in the existing file
  const savedSettings = {};
  if (ngsild.typesDirectory) savedSettings.typesDir    = ngsild.typesDirectory;
  if (ngsild.syncTimeoutMs)  savedSettings.syncTimeout = ngsild.syncTimeoutMs;
  if (raw?.dds?.ddsmodule?.dds?.domain !== undefined) {
    savedSettings.domain = raw.dds.ddsmodule.dds.domain;
  }

  // Load @context to recover IRI base
  let iriBase = null;
  if (contextPath) {
    try {
      const ctx = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
      const terms = ctx['@context'] || {};
      // Infer iriBase from the first term: IRI = base + shortName
      const firstEntry = Object.entries(terms)[0];
      if (firstEntry) {
        const [shortName, iri] = firstEntry;
        if (typeof iri === 'string' && iri.endsWith(shortName)) {
          iriBase = iri.slice(0, iri.length - shortName.length);
        }
      }
    } catch (e) {
      console.warn(`Warning: cannot read context file "${contextPath}": ${e.message}`);
    }
  }

  return { mappings, ddsmodule: raw?.dds?.ddsmodule || null, savedSettings, iriBase };
}

/** Serialize state → config JSON + @context JSON and write both files. */
function writeOutputs(state, settings) {
  const outDir = path.dirname(path.resolve(settings.outConfig));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outDirCtx = path.dirname(path.resolve(settings.outContext));
  if (!fs.existsSync(outDirCtx)) fs.mkdirSync(outDirCtx, { recursive: true });

  const { configObj, contextObj } = buildOutputObjects(state, settings);

  fs.writeFileSync(settings.outConfig,  JSON.stringify(configObj,  null, 2), 'utf8');
  fs.writeFileSync(settings.outContext, JSON.stringify(contextObj, null, 2), 'utf8');
}

function buildOutputObjects(state, settings) {
  const ngsildTopics   = {};
  const ngsildServices = {};
  const ngsildActions  = {};
  const contextTerms   = {};

  function addRow(target, row) {
    const entry = { entityId: row.entityId };
    if (row.entityType && row.entityType.trim()) entry.entityType = row.entityType.trim();
    entry.attribute = row.attribute;
    target[row.ddsName] = entry;

    // Collect @context terms (short names → IRIs)
    if (entry.entityType) {
      contextTerms[entry.entityType] = settings.iriBase + urlSafe(entry.entityType);
    }
    contextTerms[entry.attribute] = settings.iriBase + urlSafe(entry.attribute);
  }

  for (const row of state.rows.topics)   { if (row.mapped) addRow(ngsildTopics,   row); }
  for (const row of state.rows.services) { if (row.mapped) addRow(ngsildServices, row); }
  for (const row of state.rows.actions)  { if (row.mapped) addRow(ngsildActions,  row); }

  // Sync blocklisted entries into ddsmodule.dds.blocklist
  const ddsmodule = JSON.parse(JSON.stringify(state.ddsmodule)); // deep clone
  const blocklisted = [
    ...state.rows.topics,
    ...state.rows.services,
    ...state.rows.actions,
  ].filter(r => r.blocklisted).map(r => r.ddsName);

  if (blocklisted.length > 0) {
    const bl = ddsmodule.dds.blocklist;
    // Remove placeholder if present
    const placeholderIdx = bl.findIndex(e => e.name === 'add_blocked_topics_here');
    if (placeholderIdx !== -1) bl.splice(placeholderIdx, 1);
    for (const name of blocklisted) {
      if (!bl.some(e => e.name === name)) bl.push({ name });
    }
  }

  const configObj = {
    dds: {
      ddsmodule,
      ngsild: {
        typesDirectory: settings.typesDir,
        syncTimeoutMs:  settings.syncTimeout,
        topics:   ngsildTopics,
        services: ngsildServices,
        actions:  ngsildActions,
      },
    },
  };

  const contextObj = { '@context': contextTerms };
  return { configObj, contextObj };
}

function urlSafe(name) {
  return name.replace(/[^a-zA-Z0-9._~-]/g, '_');
}

module.exports = { loadExisting, writeOutputs, buildOutputObjects };
