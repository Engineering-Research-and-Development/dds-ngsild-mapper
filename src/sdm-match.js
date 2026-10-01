'use strict';

/**
 * Heuristic matching between DDS/ROS 2 data and Smart Data Model attributes.
 *
 * Two directions are supported, because the mapper and the playground answer two
 * different questions:
 *
 *   matchEndpoints() — "which SDM attribute should this whole DDS endpoint fill?"
 *     This is what the generated `dds-config.json` can actually express: one DDS
 *     endpoint → one attribute of one NGSI-LD entity.
 *
 *   matchFields() — "if I looked inside the payload, where would each field go?"
 *     A what-if view over the payload placeholder the DDS Enabler publishes. It
 *     never reaches `dds-config.json`; it exists so an operator can see whether a
 *     model really fits the data before committing to it.
 *
 * Scoring combines name similarity (token overlap after expanding ROS-flavoured
 * abbreviations: `temp`→temperature, `batt`→batteryLevel, `pose`→location, …) with
 * JSON-type compatibility. A pair with no name affinity never matches on type alone.
 */

const { cleanName } = require('./mapping');
const { typeLeaf }  = require('./suggest');

/** Tokens that carry no signal in ROS 2 names / SDM attribute names. */
const STOP_TOKENS = new Set([
  'rt', 'rq', 'rr', 'msg', 'msgs', 'srv', 'interfaces', 'ros', 'dds',
  'request', 'response', 'reply', 'goal', 'result', 'feedback',
  'stamped', 'array', 'multi', 'the', 'of', 'a',
]);

/**
 * ROS-flavoured abbreviation → the SDM vocabulary it usually means.
 * Both sides of a comparison are expanded, so `batt` on the DDS side and
 * `batteryLevel` on the SDM side meet on the shared token `battery`.
 */
const SYNONYMS = {
  temp: ['temperature'], temperature: ['temperature'],
  hum: ['humidity'], humidity: ['humidity'], rh: ['humidity'],
  batt: ['battery', 'level'], battery: ['battery', 'level'],
  soc: ['battery', 'level'], charge: ['battery', 'level'],
  percentage: ['level', 'percentage'], percent: ['level', 'percentage'],
  volt: ['voltage'], voltage: ['voltage'],
  amp: ['current'], amps: ['current'], current: ['current'],
  power: ['power'], energy: ['energy'],
  vel: ['speed', 'velocity'], velocity: ['speed', 'velocity'],
  twist: ['speed', 'velocity'], speed: ['speed', 'velocity'], rpm: ['speed'],
  odom: ['location', 'speed'], odometry: ['location', 'speed'],
  pos: ['position', 'location'], position: ['position', 'location'],
  pose: ['position', 'location'], location: ['location'], gps: ['location'],
  navsat: ['location'], fix: ['location'],
  lat: ['latitude', 'location'], latitude: ['latitude', 'location'],
  lon: ['longitude', 'location'], lng: ['longitude', 'location'],
  longitude: ['longitude', 'location'],
  alt: ['altitude'], altitude: ['altitude'], height: ['height', 'altitude'],
  press: ['pressure'], pressure: ['pressure'], atmospheric: ['pressure'],
  stamp: ['date', 'observed'], timestamp: ['date', 'observed'],
  time: ['date'], sec: ['date'], nanosec: ['date'], date: ['date'],
  state: ['status', 'state', 'mode'], status: ['status', 'state'],
  mode: ['mode', 'status'], health: ['status'],
  err: ['error'], errs: ['error'], errors: ['error'], error: ['error'],
  fault: ['error'], alarm: ['error', 'alert'],
  dist: ['distance', 'range'], distance: ['distance', 'range'],
  range: ['distance', 'range'],
  illum: ['illuminance'], light: ['illuminance'], lux: ['illuminance'],
  co2: ['co2'], gas: ['gas'], pm: ['particle'],
  cmd: ['command'], command: ['command'], ctrl: ['command'],
  dest: ['destination', 'target'], destination: ['destination', 'target'],
  target: ['target', 'destination'],
  acc: ['acceleration'], accel: ['acceleration'], accuracy: ['accuracy'],
  frame: ['name'], id: ['id'], name: ['name'], label: ['name'],
  desc: ['description'], description: ['description'],
  data: [], value: [], val: [],
  serial: ['serialnumber'], fw: ['firmwareversion'], firmware: ['firmwareversion'],
  sw: ['softwareversion'], hw: ['hardwareversion'],
  owner: ['owner'], provider: ['dataprovider'], source: ['source'],
  type: ['type'], category: ['category'], unit: ['unit'],
  level: ['level'], count: ['count'], total: ['total'],
};

// ─── Tokenisation ────────────────────────────────────────────────────────────────

/** camelCase / snake_case / slash paths → lowercase tokens, stop words dropped. */
function tokenize(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map(t => t.toLowerCase())
    .filter(t => t && t.length > 1 && !STOP_TOKENS.has(t));
}

/** Token set with synonyms folded in, so both sides share one vocabulary. */
function expand(tokens) {
  const out = new Set();
  for (const t of tokens) {
    out.add(t);
    for (const syn of SYNONYMS[t] || []) out.add(syn);
  }
  return out;
}

function normalized(name) {
  return String(name || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

// ─── Scoring ─────────────────────────────────────────────────────────────────────

function nameScore(sourceName, attrName) {
  const a = normalized(sourceName);
  const b = normalized(attrName);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const sa = expand(tokenize(sourceName));
  const sb = expand(tokenize(attrName));
  if (sa.size === 0 || sb.size === 0) return 0;

  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  const jacc  = union ? inter / union : 0;
  const cover = inter / Math.min(sa.size, sb.size);

  let score = 0.45 * jacc + 0.55 * cover;
  // "batterylevel" vs "battery": whole-string containment is a strong hint.
  if (inter > 0 && (a.includes(b) || b.includes(a))) score = Math.max(score, 0.75);
  return Math.min(1, score);
}

/** How well a JSON value type fits an SDM attribute. */
function typeScore(jsonType, attr) {
  const want = String(attr.jsonType || '').toLowerCase();
  const got  = String(jsonType || '').toLowerCase();

  if (!want || !got) return 0.6;                                    // unknown on either side
  if (attr.ngsiType === 'GeoProperty') return got === 'object' ? 0.95 : 0.3;
  if (want === got) return 1;
  if ((want === 'number' && got === 'integer') ||
      (want === 'integer' && got === 'number')) return 1;
  if (want === 'string' && attr.format === 'date-time' &&
      (got === 'number' || got === 'integer')) return 0.5;          // epoch seconds → ISO 8601
  if ((want === 'string' && (got === 'number' || got === 'integer' || got === 'boolean')) ||
      (got === 'string' && (want === 'number' || want === 'integer' || want === 'boolean'))) return 0.35;
  return 0.15;
}

/** Human-readable note when a pair does not line up cleanly. */
function compatibilityNote(jsonType, attr) {
  const want = String(attr.jsonType || '').toLowerCase();
  const got  = String(jsonType || '').toLowerCase();
  if (!want) return `${attr.name} has no declared type in the schema`;
  if (!got)  return 'no sample value to check the type against';
  if (want === got) return '';
  if ((want === 'number' && got === 'integer') || (want === 'integer' && want === 'number')) return '';
  if (want === 'string' && attr.format === 'date-time') return `${attr.name} expects an ISO 8601 date-time string`;
  if (attr.ngsiType === 'GeoProperty') return `${attr.name} is a GeoProperty — the value must be GeoJSON`;
  return `type mismatch: payload is ${got}, ${attr.name} expects ${want}`;
}

/** Combined score for one (source, attribute) pair. Name affinity gates the match. */
function scorePair(sourceName, jsonType, attr) {
  const ns = nameScore(sourceName, attr.name);
  if (ns === 0) return 0;
  return Number((0.7 * ns + 0.3 * typeScore(jsonType, attr)).toFixed(4));
}

// ─── Payload field extraction ────────────────────────────────────────────────────

const MAX_FIELD_DEPTH = 6;
const MAX_FIELDS      = 250;

function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  // A placeholder writes ROS floats as `0.0`, which JSON parses to an integer-valued
  // number — the distinction cannot be recovered, so every number stays "number".
  return typeof value;          // number | string | boolean | object
}

/**
 * Flatten the payload placeholder(s) the DDS Enabler publishes for an endpoint into
 * leaf fields: [{ path: 'linear.x', label: 'Request', jsonType: 'number', sample: 0 }].
 * Objects are also emitted as fields, so a whole sub-struct can be mapped at once.
 */
function extractFields(payloads) {
  const fields = [];

  const walk = (value, prefix, label, depth) => {
    if (fields.length >= MAX_FIELDS) return;
    const type = jsonTypeOf(value);

    if (type === 'object' && depth < MAX_FIELD_DEPTH) {
      const keys = Object.keys(value);
      if (prefix) fields.push({ path: prefix, label, jsonType: 'object', sample: value, container: true });
      for (const k of keys) walk(value[k], prefix ? `${prefix}.${k}` : k, label, depth + 1);
      return;
    }
    if (prefix) fields.push({ path: prefix, label, jsonType: type, sample: value, container: false });
  };

  for (const part of payloads || []) {
    const raw = part && part.details;
    if (raw === undefined || raw === null || raw === '') continue;
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { continue; }                          // placeholder not yet available
    walk(parsed, '', (part && part.label) || '', 0);
  }

  return fields;
}

// ─── Matching ────────────────────────────────────────────────────────────────────

const TOP_CANDIDATES = 5;

function mappableAttributes(attributes) {
  return (attributes || []).filter(a => !a.structural);
}

function candidatesFor(sourceName, jsonType, attributes) {
  return mappableAttributes(attributes)
    .map(attr => ({
      attribute: attr.name,
      ngsiType:  attr.ngsiType,
      jsonType:  attr.jsonType,
      required:  attr.required,
      score:     scorePair(sourceName, jsonType, attr),
      note:      compatibilityNote(jsonType, attr),
    }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.required) - Number(a.required))
    .slice(0, TOP_CANDIDATES);
}

/**
 * Greedy one-to-one assignment: the globally best pairs are taken first, and an
 * attribute is never proposed twice (NGSI-LD entities hold one value per attribute).
 */
function assignGreedy(items, attributes, threshold) {
  const taken = new Set();
  const order = items
    .map((item, idx) => ({ idx, best: item.candidates[0] ? item.candidates[0].score : 0 }))
    .sort((a, b) => b.best - a.best);

  for (const { idx } of order) {
    const item = items[idx];
    const pick = item.candidates.find(c => c.score >= threshold && !taken.has(c.attribute));
    if (pick) {
      item.chosen = pick.attribute;
      item.score  = pick.score;
      item.note   = pick.note;
      taken.add(pick.attribute);
    } else {
      item.chosen = '';
      item.score  = item.candidates[0] ? item.candidates[0].score : 0;
      item.note   = '';
    }
  }
  return items;
}

/** Payload field → SDM attribute (what-if view, preview only). */
function matchFields(fields, attributes, { threshold = 0.45 } = {}) {
  const items = (fields || []).map(f => ({
    path:     f.path,
    label:    f.label,
    jsonType: f.jsonType,
    sample:   f.sample,
    // Leaf name carries the meaning: "twist.linear.x" is matched on "linear x".
    candidates: candidatesFor(f.path.split('.').slice(-2).join(' '), f.jsonType, attributes),
  }));
  return assignGreedy(items, attributes, threshold);
}

/**
 * DDS endpoint → SDM attribute. This is the direction `dds-config.json` can express,
 * so it drives the "apply to mapping" button.
 *
 * `endpoints`: [{ kind, ddsName, ddsTypeInfo, payloads }]
 */
function matchEndpoints(endpoints, attributes, { threshold = 0.4 } = {}) {
  const items = (endpoints || []).map(ep => {
    const payloadFields = extractFields(ep.payloads);
    // The whole payload lands in one attribute, so the source "shape" is an object
    // whenever the endpoint publishes a struct, and the scalar type when it does not.
    const jsonType = payloadFields.length > 1 ? 'object'
      : payloadFields.length === 1 ? payloadFields[0].jsonType
      : '';
    const leaf = typeLeaf(ep.ddsTypeInfo || '');
    const sourceName = `${cleanName(ep.ddsName)} ${leaf}`.trim();

    return {
      kind:       ep.kind,
      ddsName:    ep.ddsName,
      jsonType,
      fieldCount: payloadFields.length,
      candidates: candidatesFor(sourceName, jsonType, attributes),
    };
  });
  return assignGreedy(items, attributes, threshold);
}

/**
 * Report on a proposed set of assignments: required attributes still empty, type
 * mismatches, and attributes used more than once.
 */
function report(assignments, attributes) {
  const warnings = [];
  const byName   = new Map(mappableAttributes(attributes).map(a => [a.name, a]));
  const used     = new Map();

  for (const a of assignments || []) {
    if (!a.chosen) continue;
    used.set(a.chosen, (used.get(a.chosen) || 0) + 1);

    const attr = byName.get(a.chosen);
    if (!attr) {
      warnings.push(`"${a.chosen}" is not an attribute of this data model`);
      continue;
    }
    const note = compatibilityNote(a.jsonType, attr);
    if (note) warnings.push(`${a.path || a.ddsName} → ${note}`);
  }

  for (const [name, n] of used) {
    if (n > 1) warnings.push(`"${name}" is assigned ${n} times — an entity holds one value per attribute`);
  }

  const missingRequired = mappableAttributes(attributes)
    .filter(a => a.required && !used.has(a.name))
    .map(a => a.name);

  return {
    warnings,
    missingRequired,
    assigned:   used.size,
    unassigned: (assignments || []).filter(a => !a.chosen).length,
  };
}

module.exports = {
  extractFields,
  matchFields,
  matchEndpoints,
  report,
  // exported for tests / reuse
  tokenize,
  nameScore,
  typeScore,
  scorePair,
  compatibilityNote,
  jsonTypeOf,
};
