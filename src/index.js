#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { parseArgs }      = require('util');
const cfg                = require('../config');
const { loadDiscovery }  = require('./discovery');
const { buildMapping, applyAutoDefaults } = require('./mapping');
const { loadExisting, writeOutputs }      = require('./files');
const { runInteractive } = require('./interactive');
const { validate }       = require('./validator');

// ─── CLI help ─────────────────────────────────────────────────────────────────

const USAGE = `
dds-ngsi-mapper — DDS discovery to NGSI-LD mapping tool

Settings are read from .env (project root). CLI flags override .env values.

USAGE
  dds-ngsi-mapper [options]

DISCOVERY SOURCE  (CLI > DDS_DISCOVERY_FILE > DDS_DISCOVERY_URL)
  -i, --input <file>       Local DDS discovery inventory JSON file
  --discovery-url <url>    HTTP URL of the DDS Enabler discovery endpoint

ROUND-TRIP EDITING
  --config <file>          Load an existing output config to edit
  --context <file>         Paired @context file (used with --config)

OUTPUT
  --out-config  <file>     Config file to write   [env: OUTPUT_CONFIG_FILE]
  --out-context <file>     Context file to write  [env: OUTPUT_CONTEXT_FILE]

NGSI-LD
  --iri-base <url>         IRI base URL           [env: NGSI_IRI_BASE]
  --context-uri <uri>      -duc URI for Orion-LD  [env: NGSI_CONTEXT_URI]

DDS
  --domain <n>             DDS domain ID          [env: DDS_DOMAIN]
  --types-dir <path>       DDS types directory    [env: DDS_TYPES_DIR]
  --sync-timeout <ms>      Sync timeout           [env: DDS_SYNC_TIMEOUT_MS]

BEHAVIOUR
  --auto                   Auto-map all with defaults, skip prompts  [env: MAPPER_MODE=auto]
  -h, --help               Show this help

EXAMPLES
  # Live discovery from backend (configured in .env)
  dds-ngsi-mapper

  # Override discovery URL at runtime
  dds-ngsi-mapper --discovery-url http://localhost:8080/api/discovery --auto

  # Use a local snapshot instead of live discovery
  dds-ngsi-mapper --input examples/discovery.json --auto

  # Round-trip: load existing files, merge new discovery, re-save
  dds-ngsi-mapper --input examples/discovery.json --config out/dds-config.json --context out/dds-context.jsonld
`.trim();

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseCli() {
  return parseArgs({
    args: process.argv.slice(2),
    options: {
      input:           { type: 'string',  short: 'i' },
      'discovery-url': { type: 'string' },
      config:          { type: 'string' },
      context:         { type: 'string' },
      'out-config':    { type: 'string' },
      'out-context':   { type: 'string' },
      'iri-base':      { type: 'string' },
      'context-uri':   { type: 'string' },
      domain:          { type: 'string' },
      'types-dir':     { type: 'string' },
      'sync-timeout':  { type: 'string' },
      auto:            { type: 'boolean', default: false },
      help:            { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  }).values;
}

// ─── Merge CLI over config ────────────────────────────────────────────────────

function buildSettings(cli) {
  return {
    discoveryUrl:     cli['discovery-url'] || cfg.discovery.url,
    discoveryFile:    cli.input            || cfg.discovery.localFile,
    discoveryTimeout: cfg.discovery.timeoutMs,

    domain:      cli.domain       ? parseInt(cli.domain, 10)       : cfg.dds.domain,
    typesDir:    cli['types-dir']  || cfg.dds.typesDir,
    syncTimeout: cli['sync-timeout'] ? parseInt(cli['sync-timeout'], 10) : cfg.dds.syncTimeout,

    iriBase:    cli['iri-base']    || cfg.ngsi.iriBase,
    contextUri: cli['context-uri'] || cfg.ngsi.contextUri,

    outConfig:  cli['out-config']  || cfg.output.configFile,
    outContext: cli['out-context'] || cfg.output.contextFile,

    auto: cli.auto || cfg.mode === 'auto',
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let cli;
  try { cli = parseCli(); } catch (e) {
    console.error(`Error: ${e.message}\n\n${USAGE}`);
    process.exit(1);
  }

  if (cli.help) { console.log(USAGE); process.exit(0); }

  let settings = buildSettings(cli);

  // ── Discovery source ───────────────────────────────────────────────────────
  let discovery = { topics: [], services: [], actions: [] };

  if (settings.discoveryFile) {
    console.log(`Discovery source: file  → ${settings.discoveryFile}`);
    discovery = await loadDiscovery({ filePath: settings.discoveryFile });
  } else if (settings.discoveryUrl) {
    console.log(`Discovery source: HTTP  → ${settings.discoveryUrl}`);
    discovery = await loadDiscovery({ url: settings.discoveryUrl, timeoutMs: settings.discoveryTimeout });
  } else if (!cli.config) {
    console.error(
      'Error: no discovery source.\n' +
      '  Set DDS_DISCOVERY_URL or DDS_DISCOVERY_FILE in .env, or pass --input / --discovery-url'
    );
    process.exit(1);
  }

  const { topics, services, actions } = discovery;
  if (topics.length + services.length + actions.length > 0) {
    console.log(`Discovered: ${topics.length} topics, ${services.length} services, ${actions.length} actions`);
  }

  // ── Round-trip: load existing config ──────────────────────────────────────
  let existing = { mappings: { topics: {}, services: {}, actions: {} }, ddsmodule: null, savedSettings: {}, iriBase: null };
  if (cli.config) {
    existing = loadExisting(cli.config, cli.context || null);
    console.log(`Loaded existing config: ${cli.config}`);
    // Merge saved values (CLI still wins)
    if (existing.savedSettings.typesDir    && !cli['types-dir'])    settings.typesDir    = existing.savedSettings.typesDir;
    if (existing.savedSettings.syncTimeout && !cli['sync-timeout']) settings.syncTimeout = existing.savedSettings.syncTimeout;
    if (existing.savedSettings.domain      && !cli.domain)          settings.domain      = existing.savedSettings.domain;
    if (existing.iriBase                   && !cli['iri-base'])     settings.iriBase     = existing.iriBase;
  }

  // ── Build mapping state ───────────────────────────────────────────────────
  let state = buildMapping(discovery, existing, settings);

  // ── Map rows ──────────────────────────────────────────────────────────────
  if (settings.auto) {
    state = applyAutoDefaults(state);
    console.log(`Auto-mapped: ${countMapped(state)} entries`);
  } else {
    state = await runInteractive(state, settings);
  }

  // ── Validate ──────────────────────────────────────────────────────────────
  const errors = validate(state);
  if (errors.length > 0) {
    console.error('\nValidation errors:');
    for (const err of errors) console.error(`  • ${err}`);
    process.exit(1);
  }

  // ── Write output files ────────────────────────────────────────────────────
  writeOutputs(state, settings);

  console.log(`\nDone — ${countMapped(state)} entries mapped.`);
  console.log(`  Config  → ${settings.outConfig}`);
  console.log(`  Context → ${settings.outContext}`);
  printLaunchHint(settings);
}

function countMapped(state) {
  return ['topics', 'services', 'actions'].reduce((n, k) => n + state.rows[k].filter(r => r.mapped).length, 0);
}

function printLaunchHint(settings) {
  const duc = settings.contextUri || settings.outContext;
  console.log(`\nOrion-LD launch:`);
  console.log(`  orionld -wip dds --config ${settings.outConfig} -duc ${duc}`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
