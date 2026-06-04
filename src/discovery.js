'use strict';

const fs   = require('fs');
const http  = require('http');
const https = require('https');

/**
 * Load the DDS discovery inventory from either:
 *  - a local JSON file (filePath)
 *  - an HTTP/HTTPS endpoint (url)
 *
 * Expected payload format:
 * {
 *   "topics":   [ { "name": "rt/cmd_vel", "typeName": "geometry_msgs/msg/Twist", "qos":{} } ],
 *   "services": [ { "name": "set_bool",   "requestType": "...", "replyType": "..." } ],
 *   "actions":  [ { "name": "navigate",   "goalType": "...", "feedbackType": "...", "resultType": "..." } ]
 * }
 */
async function loadDiscovery({ filePath, url, timeoutMs = 10000 }) {
  let raw;
  if (filePath) {
    raw = loadFromFile(filePath);
  } else if (url) {
    raw = await fetchFromUrl(url, timeoutMs);
  } else {
    throw new Error('loadDiscovery: provide either filePath or url');
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

// ─── HTTP fetch (no external deps — uses Node built-in http/https) ─────────────

function fetchFromUrl(url, timeoutMs) {
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
