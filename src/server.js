#!/usr/bin/env node
'use strict';

require('dotenv').config();

const http = require('http');
const fs   = require('fs');
const path = require('path');

const cfg                  = require('../config');
const { loadDiscovery }    = require('./discovery');
const { buildMapping, makeDefaultDdsmodule } = require('./mapping');
const { buildOutputObjects } = require('./files');
const { validate }         = require('./validator');
const { suggestRow }       = require('./suggest');

const PORT    = cfg.web.port;
const WEB_DIR = path.join(__dirname, '..', 'web');

// ─── Default settings exposed to the UI (CLI/.env values pre-fill the form) ──────

function defaultSettings() {
  return {
    discoveryUrl:  cfg.discovery.url      || '',
    discoveryFile: cfg.discovery.localFile || '',
    iriBase:       cfg.ngsi.iriBase,
    contextUri:    cfg.ngsi.contextUri || '',
    domain:        cfg.dds.domain,
    typesDir:      cfg.dds.typesDir,
    syncTimeout:   cfg.dds.syncTimeout,
    outConfig:     cfg.output.configFile,
    outContext:    cfg.output.contextFile,
    autoBlocklistLogs: cfg.autoBlocklistLogs,
    ws:            cfg.discovery.ws,
  };
}

// ─── Build editable rows (discovery + per-row suggestions) ───────────────────────

function buildRowsForUi(discovery, settings) {
  const state = buildMapping(discovery, emptyExisting(), settings);
  const decorate = (kind) => state.rows[kind].map(row => {
    const item = findItem(discovery, kind, row.ddsName);
    const suggestions = item ? suggestRow(singular(kind), item) : null;
    return {
      kind:        singular(kind),
      ddsName:     row.ddsName,
      ddsTypeInfo: row.ddsTypeInfo,
      isLog:       !!row.isLog,
      // Each row starts "mapped" with suggested values so the UI is productive; log
      // topics (rosout / rcl_interfaces/msg/Log) instead default to blocklist when
      // settings.autoBlocklistLogs is on. The operator can override any of this.
      action:      row.blocklisted ? 'blocklist' : 'map',   // 'map' | 'skip' | 'blocklist'
      entityType:  (suggestions && suggestions.entityType) || row.entityType,
      entityId:    (suggestions && suggestions.entityId)   || row.entityId,
      attribute:   (suggestions && suggestions.attribute)  || row.attribute,
      suggestions: suggestions || { entityType: row.entityType, entityId: row.entityId, attribute: row.attribute },
    };
  });

  return {
    topics:   decorate('topics'),
    services: decorate('services'),
    actions:  decorate('actions'),
  };
}

function findItem(discovery, kind, name) {
  return (discovery[kind] || []).find(x => x.name === name) || null;
}

function emptyExisting() {
  return { mappings: { topics: {}, services: {}, actions: {} }, ddsmodule: null, savedSettings: {}, iriBase: null };
}

function singular(kind) {
  return { topics: 'topic', services: 'service', actions: 'action' }[kind] || kind;
}

// ─── Reconstruct mapping state from the UI payload, validate, serialize ──────────

function generate(payload) {
  const settings = { ...defaultSettings(), ...(payload.settings || {}) };
  const rowsIn   = payload.rows || {};

  const toRow = (r) => ({
    ddsName:     r.ddsName,
    entityId:    (r.entityId || '').trim(),
    entityType:  (r.entityType || '').trim(),
    attribute:   (r.attribute || '').trim(),
    mapped:      r.action === 'map',
    blocklisted: r.action === 'blocklist',
  });

  const state = {
    settings,
    ddsmodule: payload.ddsmodule || makeDefaultDdsmodule(settings),
    rows: {
      topics:   (rowsIn.topics   || []).map(toRow),
      services: (rowsIn.services || []).map(toRow),
      actions:  (rowsIn.actions  || []).map(toRow),
    },
  };

  const errors = validate(state);
  if (errors.length > 0) return { ok: false, errors };

  const { configObj, contextObj } = buildOutputObjects(state, settings);
  return { ok: true, config: configObj, context: contextObj };
}

function writeToDisk(settings, configObj, contextObj) {
  for (const p of [settings.outConfig, settings.outContext]) {
    const dir = path.dirname(path.resolve(p));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(settings.outConfig,  JSON.stringify(configObj,  null, 2), 'utf8');
  fs.writeFileSync(settings.outContext, JSON.stringify(contextObj, null, 2), 'utf8');
}

// ─── HTTP plumbing ───────────────────────────────────────────────────────────────

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 8 * 1024 * 1024) {     // 8 MB guard
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve within WEB_DIR and reject path traversal
  const filePath = path.join(WEB_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ─── API routes ──────────────────────────────────────────────────────────────────

async function handleApi(req, res, route) {
  if (route === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { settings: defaultSettings() });
  }

  if (route === '/api/discovery' && req.method === 'POST') {
    const body = await readBody(req);
    const settings = { ...defaultSettings(), ...(body.settings || {}) };

    let discovery;
    if (body.data) {
      discovery = await loadDiscovery({ data: body.data });
    } else if (body.url) {
      const isWs = /^wss?:/i.test(body.url);
      discovery = await loadDiscovery({
        url:       body.url,
        timeoutMs: cfg.discovery.timeoutMs,
        ws:        isWs ? { ...cfg.discovery.ws, ...(body.ws || {}) } : {},
      });
    } else if (body.filePath) {
      discovery = await loadDiscovery({ filePath: body.filePath });
    } else {
      return sendJson(res, 400, { error: 'provide one of: data, url, filePath' });
    }

    const rows = buildRowsForUi(discovery, settings);
    const counts = {
      topics:   discovery.topics.length,
      services: discovery.services.length,
      actions:  discovery.actions.length,
    };
    return sendJson(res, 200, { counts, rows });
  }

  if (route === '/api/generate' && req.method === 'POST') {
    const body   = await readBody(req);
    const result = generate(body);
    if (!result.ok) return sendJson(res, 422, result);

    if (body.write) {
      const settings = { ...defaultSettings(), ...(body.settings || {}) };
      try {
        writeToDisk(settings, result.config, result.context);
        result.written = { outConfig: settings.outConfig, outContext: settings.outContext };
      } catch (e) {
        return sendJson(res, 500, { ok: false, errors: [`write failed: ${e.message}`] });
      }
    }
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { error: `no route ${req.method} ${route}` });
}

// ─── Server ──────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const route = req.url.split('?')[0];
  try {
    if (route.startsWith('/api/')) return await handleApi(req, res, route);
    return serveStatic(req, res);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`dds-ngsi-mapper web UI  →  http://localhost:${PORT}`);
  console.log(`  API: GET /api/config · POST /api/discovery · POST /api/generate`);
  console.log('  Press Ctrl+C to stop.');
});

module.exports = { server, generate, buildRowsForUi, defaultSettings };
