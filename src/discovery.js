'use strict';

const fs    = require('fs');
const http  = require('http');
const https = require('https');
const WebSocket = require('ws');

/**
 * Load the DDS discovery inventory from either:
 *  - a local JSON file (filePath)
 *  - an HTTP/HTTPS endpoint (url)
 *  - a WebSocket endpoint (ws:// or wss://) that streams the DDS Enabler discovery
 *
 * Expected payload format (snapshot, file / HTTP / a single WS frame):
 * {
 *   "topics":   [ { "name": "rt/cmd_vel", "typeName": "geometry_msgs/msg/Twist", "qos":{} } ],
 *   "services": [ { "name": "set_bool",   "requestType": "...", "replyType": "..." } ],
 *   "actions":  [ { "name": "navigate",   "goalType": "...", "feedbackType": "...", "resultType": "..." } ]
 * }
 *
 * Over WebSocket the backend may instead stream one entry per frame:
 *   { "kind": "topic",   "name": "rt/cmd_vel", "typeName": "..." , "qos": {} }
 *   { "kind": "service", "name": "set_bool",   "requestType": "...", "replyType": "..." }
 *   { "kind": "action",  "name": "navigate",   "goalType": "...", ... }
 * These frames are accumulated until the stream goes quiet (see ws.quietWindowMs)
 * or the connection closes.
 *
 * @param {object}  opts
 * @param {object} [opts.data]       Already-parsed discovery object (e.g. uploaded/pasted JSON).
 * @param {string} [opts.filePath]   Local discovery JSON file.
 * @param {string} [opts.url]        http(s):// or ws(s):// discovery endpoint.
 * @param {number} [opts.timeoutMs]  Hard timeout for remote sources (default 10000).
 * @param {object} [opts.ws]         WebSocket-specific options (see fetchFromWebSocket).
 */
async function loadDiscovery({ data, filePath, url, timeoutMs = 10000, ws = {} } = {}) {
  let raw;
  if (data) {
    raw = data;
  } else if (filePath) {
    raw = loadFromFile(filePath);
  } else if (url) {
    raw = await fetchFromUrl(url, timeoutMs, ws);
  } else {
    throw new Error('loadDiscovery: provide data, filePath or url');
  }
  return normalize(raw);
}

// ─── Local file ───────────────────────────────────────────────────────────────

function loadFromFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read discovery file "${filePath}": ${e.message}`);
  }
}

// ─── Transport dispatch (http/https vs ws/wss) ──────────────────────────────────

function normalizeDiscoveryUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    throw new Error(`Invalid discovery URL "${url}": ${e.message}`);
  }

  if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
    if (parsedUrl.pathname === '' || parsedUrl.pathname === '/') {
      parsedUrl.pathname = '/api/discovery';
    }
    return parsedUrl.toString();
  }

  if (parsedUrl.protocol === 'ws:' || parsedUrl.protocol === 'wss:') {
    return url;
  }

  throw new Error(
    `Protocol "${parsedUrl.protocol}" not supported. Expected http:, https:, ws:, or wss:`
  );
}

function fetchFromUrl(url, timeoutMs, ws = {}) {
  let normalizedUrl;
  let parsedUrl;
  try {
    normalizedUrl = normalizeDiscoveryUrl(url);
    parsedUrl = new URL(normalizedUrl);
  } catch (e) {
    return Promise.reject(e);
  }

  if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
    return fetchFromHttp(normalizedUrl, timeoutMs);
  }

  if (parsedUrl.protocol === 'ws:' || parsedUrl.protocol === 'wss:') {
    return fetchFromWebSocket(normalizedUrl, timeoutMs, ws);
  }

  return Promise.reject(
    new Error(`Protocol "${parsedUrl.protocol}" not supported. Expected http:, https:, ws:, or wss:`)
  );
}

/* function fetchFromUrl(url, timeoutMs, ws = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    return Promise.reject(new Error(`Invalid discovery URL "${url}": ${e.message}`));
  }

  if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
    return fetchFromHttp(url, timeoutMs);
  }

  if (parsedUrl.protocol === 'ws:' || parsedUrl.protocol === 'wss:') {
    return fetchFromWebSocket(url, timeoutMs, ws);
  }

  return Promise.reject(
    new Error(`Protocol "${parsedUrl.protocol}" not supported. Expected http:, https:, ws:, or wss:`)
  );
} */

// ─── HTTP fetch (no external deps — uses Node built-in http/https) ──────────────

function fetchFromHttp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const req = transport.get(url, { timeout: timeoutMs }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Discovery endpoint returned HTTP ${res.statusCode}: ${url}`));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error(`Discovery endpoint returned invalid JSON: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Discovery endpoint timed out after ${timeoutMs} ms: ${url}`));
    });

    req.on('error', e => reject(new Error(`Cannot reach discovery endpoint "${url}": ${e.message}`)));
  });
}

// ─── WebSocket fetch ────────────────────────────────────────────────────────────

/**
 * Connect to a WebSocket discovery endpoint and collect topics/services/actions.
 *
 * @param {string} url
 * @param {number} timeoutMs                 Hard cap on the whole exchange.
 * @param {object} [ws]
 * @param {number} [ws.quietWindowMs=1000]   Flush after this much silence following the
 *                                           first frame (streamed/event mode).
 * @param {string|object} [ws.subscribe]     Message sent right after the socket opens
 *                                           (objects are JSON-stringified). Use it when the
 *                                           backend needs an explicit subscribe/start request.
 * @param {boolean} [ws.settleOnSnapshot=true] Resolve immediately when a frame already
 *                                           contains full topics/services/actions arrays.
 * @param {object} [ws.headers]              Extra handshake headers (e.g. Authorization).
 * @param {boolean} [ws.verbose=false]       Log every raw frame received.
 */
function fetchFromWebSocket(url, timeoutMs, ws = {}) {
  const {
    quietWindowMs    = 1000,
    subscribe        = null,
    settleOnSnapshot = true,
    headers          = undefined,
    verbose          = false,
  } = ws;

  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, headers ? { headers } : undefined);

    const acc = { topics: [], services: [], actions: [] };
    let settled = false;
    let received = 0;
    let idleTimer = null;

    const done = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      try { client.close(); } catch (_) { /* ignore */ }
      if (err) reject(err);
      else resolve(data);
    };

    const flush = () => done(null, acc);

    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(flush, quietWindowMs);
    };

    // Hard timeout: flush whatever we have if we got anything, otherwise it's an error.
    const hardTimer = setTimeout(() => {
      if (received > 0) flush();
      else done(new Error(`WebSocket discovery timed out after ${timeoutMs} ms (no data): ${url}`));
    }, timeoutMs);

    client.on('open', () => {
      if (subscribe == null) return;
      const payload = typeof subscribe === 'string' ? subscribe : JSON.stringify(subscribe);
      try { client.send(payload); } catch (e) {
        done(new Error(`Cannot send WebSocket subscribe message to ${url}: ${e.message}`));
      }
    });

    client.on('message', msg => {
      const raw = msg.toString('utf8');
      if (verbose) console.log('[WS RAW]', raw);

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // A single malformed frame must not abort the whole discovery stream.
        console.warn(`Warning: skipping invalid WebSocket frame: ${e.message}`);
        armIdle();
        return;
      }

      received++;

      // Full snapshot in one frame → use it directly.
      if (isSnapshot(parsed)) {
        if (settleOnSnapshot) return done(null, parsed);
        mergeSnapshot(acc, parsed);
        armIdle();
        return;
      }

      // Single streamed entry → accumulate by kind.
      accumulateEntry(acc, parsed);
      armIdle();
    });

    client.on('error', e => {
      done(new Error(`Cannot reach discovery WebSocket "${url}": ${e.message}`));
    });

    client.on('close', () => {
      // Server ended the stream: resolve with whatever we collected (even if empty).
      if (!settled) flush();
    });
  });
}

function isSnapshot(parsed) {
  return !!parsed && (
    Array.isArray(parsed.topics) ||
    Array.isArray(parsed.services) ||
    Array.isArray(parsed.actions)
  );
}

function mergeSnapshot(acc, snap) {
  for (const t of snap.topics   || []) pushUnique(acc.topics,   coerceTopic(t));
  for (const s of snap.services || []) pushUnique(acc.services, coerceService(s));
  for (const a of snap.actions  || []) pushUnique(acc.actions,  coerceAction(a));
}

function accumulateEntry(acc, parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.kind || !parsed.name) return;
  const kind = String(parsed.kind).toLowerCase();
  if (kind === 'topic')        pushUnique(acc.topics,   coerceTopic(parsed));
  else if (kind === 'service') pushUnique(acc.services, coerceService(parsed));
  else if (kind === 'action')  pushUnique(acc.actions,  coerceAction(parsed));
}

function coerceTopic(t) {
  return {
    name:     t.name,
    typeName: t.typeName || t.type || t.type_name || '',
    qos:      t.qos || null,
  };
}

function coerceService(s) {
  return {
    name:        s.name,
    requestType: s.requestType || s.request_type || '',
    replyType:   s.replyType   || s.reply_type   || '',
  };
}

function coerceAction(a) {
  return {
    name:         a.name,
    goalType:     a.goalType     || a.goal_type     || '',
    feedbackType: a.feedbackType || a.feedback_type || '',
    resultType:   a.resultType   || a.result_type   || '',
  };
}

function pushUnique(arr, item) {
  if (!item || !item.name) return;
  if (!arr.some(x => x.name === item.name)) arr.push(item);
}

// ─── Normalisation ────────────────────────────────────────────────────────────

function normalize(raw) {
  return {
    topics:   (raw.topics   || []).map(normalTopic),
    services: (raw.services || []).map(normalService),
    actions:  (raw.actions  || []).map(normalAction),
  };
}

function normalTopic(t) {
  return {
    name:     requireString(t, 'name'),
    typeName: t.typeName || t.type || t.type_name || '',
    qos:      t.qos || null,
  };
}

function normalService(s) {
  return {
    name:        requireString(s, 'name'),
    requestType: s.requestType || s.request_type || '',
    replyType:   s.replyType   || s.reply_type   || '',
  };
}

function normalAction(a) {
  return {
    name:         requireString(a, 'name'),
    goalType:     a.goalType     || a.goal_type     || '',
    feedbackType: a.feedbackType || a.feedback_type || '',
    resultType:   a.resultType   || a.result_type   || '',
  };
}

function requireString(obj, field) {
  if (typeof obj[field] !== 'string' || !obj[field]) {
    throw new Error(`Discovery entry missing required field "${field}": ${JSON.stringify(obj)}`);
  }
  return obj[field];
}

module.exports = { loadDiscovery };
