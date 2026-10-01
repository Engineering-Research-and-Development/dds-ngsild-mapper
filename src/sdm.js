'use strict';

/**
 * Smart Data Models catalog client — https://github.com/smart-data-models
 *
 * The mapper lets an operator try a DDS endpoint against a *real* Smart Data Model
 * instead of inventing an entityType/attribute pair. That needs three things from
 * the Smart Data Models GitHub organisation:
 *
 *   1. the official list of subjects/data models
 *      (data-models/specs/AllSubjects/official_list_data_models.json);
 *   2. each model's JSON Schema (<repo>/<model>/schema.json), which is heavily
 *      `$ref`/`allOf` based and must be flattened to get the attribute list;
 *   3. each repository's `context.jsonld`, the authoritative short-name → IRI map.
 *      It cannot be guessed: `batteryLevel` expands under smartdatamodels.org/<repo>/,
 *      `location` expands to uri.etsi.org/ngsi-ld/location and `dateObserved` to
 *      smartdatamodels.org/ without the repo segment.
 *
 * Everything is fetched on demand and cached in memory + on disk, so the playground
 * stays responsive and keeps working when GitHub is unreachable (a stale cache entry
 * beats no answer). Only smart-data-models hosts are ever contacted.
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const cfg = require('../config');

const SDM = cfg.sdm;

/** Hosts this module is allowed to fetch from. */
const ALLOWED_HOSTS = new Set([
  'raw.githubusercontent.com',
  'smart-data-models.github.io',
  'smartdatamodels.org',
]);

const MAX_BYTES     = 8 * 1024 * 1024;   // per-document guard
const MAX_REDIRECTS = 5;
const MAX_DEPTH     = 6;                 // $ref / allOf recursion guard

const memCache = new Map();              // url → { at, value }

// ─── URL helpers ─────────────────────────────────────────────────────────────────

function repoBase(repo)          { return `${SDM.rawBase}/${repo}/${SDM.branch}`; }
function schemaUrl(repo, model)  { return `${repoBase(repo)}/${model}/schema.json`; }
function contextUrl(repo)        { return `${repoBase(repo)}/context.jsonld`; }
function exampleUrl(repo, model) { return `${repoBase(repo)}/${model}/examples/example-normalized.jsonld`; }
function docUrl(repo, model)     { return `https://github.com/smart-data-models/${repo}/tree/${SDM.branch}/${model}`; }
function fallbackIri(repo, name) { return `https://smartdatamodels.org/${repo}/${name}`; }

// ─── Fetch + cache ───────────────────────────────────────────────────────────────

function cacheFile(url) {
  const key = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(path.resolve(SDM.cacheDir), `${key}.json`);
}

function readDiskCache(url) {
  try {
    const entry = JSON.parse(fs.readFileSync(cacheFile(url), 'utf8'));
    if (entry && typeof entry.at === 'number') return entry;
  } catch { /* no cache yet, or unreadable — treat as a miss */ }
  return null;
}

function writeDiskCache(url, entry) {
  try {
    const dir = path.resolve(SDM.cacheDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile(url), JSON.stringify({ url, ...entry }), 'utf8');
  } catch (e) {
    console.warn(`Warning: cannot cache ${url}: ${e.message}`);
  }
}

function httpGetJson(url, timeoutMs, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch (e) { return reject(new Error(`invalid URL: ${e.message}`)); }

    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
      return reject(new Error(`host "${parsed.hostname}" is not a Smart Data Models host`));
    }

    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'dds-ngsi-mapper', Accept: 'application/json' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpGetJson(next, timeoutMs, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); return reject(new Error('document too large')); }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error(`invalid JSON: ${e.message}`)); }
      });
    });

    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout after ${timeoutMs} ms`)); });
    req.on('error', reject);
  });
}

/** Fetch a JSON document, preferring a fresh cache entry and falling back to a stale one. */
async function fetchJson(url) {
  const now = Date.now();
  const hit = memCache.get(url);
  if (hit && now - hit.at < SDM.cacheTtlMs) return hit.value;

  const disk = readDiskCache(url);
  if (disk && now - disk.at < SDM.cacheTtlMs) { memCache.set(url, disk); return disk.value; }

  try {
    const value = await httpGetJson(url, SDM.timeoutMs);
    const entry = { at: now, value };
    memCache.set(url, entry);
    writeDiskCache(url, entry);
    return value;
  } catch (e) {
    // Offline or GitHub unreachable: a stale copy beats no answer at all.
    if (disk) { memCache.set(url, disk); return disk.value; }
    throw new Error(`cannot fetch ${url}: ${e.message}`);
  }
}

/** Like fetchJson but returns null instead of throwing (optional documents). */
async function fetchJsonOptional(url) {
  try { return await fetchJson(url); }
  catch { return null; }
}

/** When a document was last fetched, and whether that copy is still within the TTL. */
function cacheInfo(url) {
  const entry = memCache.get(url) || readDiskCache(url);
  if (!entry) return { cached: false, fetchedAt: null, fresh: false, ttlMs: SDM.cacheTtlMs };
  return {
    cached:    true,
    fetchedAt: new Date(entry.at).toISOString(),
    ageMs:     Date.now() - entry.at,
    fresh:     Date.now() - entry.at < SDM.cacheTtlMs,
    ttlMs:     SDM.cacheTtlMs,
  };
}

/** Number of documents currently held on disk, for the startup log. */
function cacheSize() {
  try { return fs.readdirSync(path.resolve(SDM.cacheDir)).filter(f => f.endsWith('.json')).length; }
  catch { return 0; }
}

/**
 * Pull the catalog into the cache ahead of the first request, so the playground's
 * search box answers instantly (and keeps answering if GitHub goes away later).
 * Failures are non-fatal: the UI falls back to the pasted-schema path.
 */
async function warmCache() {
  try {
    const catalog = await getCatalog();
    return { ok: true, models: catalog.count, documents: cacheSize() };
  } catch (e) {
    return { ok: false, error: e.message, documents: cacheSize() };
  }
}

// ─── Catalog ─────────────────────────────────────────────────────────────────────

/**
 * Flatten the official list into one entry per data model:
 *   { repo: 'dataModel.Device', model: 'DeviceMeasurement', domains: ['Smart-Sensoring'] }
 */
async function getCatalog() {
  const raw     = await fetchJson(SDM.listUrl);
  const list    = raw.officialList || [];
  const entries = [];

  for (const subject of list) {
    const repo    = subject.repoName;
    const domains = subject.domains || [];
    for (const model of subject.dataModels || []) {
      entries.push({
        repo,
        model,
        domains,
        repoLink: subject.repoLink || `https://github.com/smart-data-models/${repo}`,
      });
    }
  }
  entries.sort((a, b) => a.model.localeCompare(b.model) || a.repo.localeCompare(b.repo));

  const domains = [...new Set(entries.flatMap(e => e.domains))].sort();
  return { updatedDate: raw.updatedDate || null, count: entries.length, domains, entries };
}

/** Substring search over model / repo / domain, ranked so exact model hits come first. */
async function searchCatalog({ q = '', domain = '', limit = 60 } = {}) {
  const catalog = await getCatalog();
  const needle  = String(q).trim().toLowerCase();

  let hits = catalog.entries;
  if (domain) hits = hits.filter(e => e.domains.includes(domain));

  if (needle) {
    hits = hits
      .map(e => ({ e, rank: rankEntry(e, needle) }))
      .filter(x => x.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.e.model.localeCompare(b.e.model))
      .map(x => x.e);
  }

  const max = Math.max(1, Math.min(Number(limit) || 60, 500));
  return {
    updatedDate: catalog.updatedDate,
    total:       catalog.count,
    domains:     catalog.domains,
    matched:     hits.length,
    entries:     hits.slice(0, max),
    cache:       cacheInfo(SDM.listUrl),
  };
}

function rankEntry(entry, needle) {
  const model = entry.model.toLowerCase();
  const repo  = entry.repo.toLowerCase();
  if (model === needle)         return 100;
  if (model.startsWith(needle)) return 80;
  if (model.includes(needle))   return 60;
  if (repo.includes(needle))    return 40;
  if (entry.domains.some(d => d.toLowerCase().includes(needle))) return 20;
  return 0;
}

// ─── Schema flattening ───────────────────────────────────────────────────────────

/** Split a `$ref` into its document URL and JSON-pointer fragment. */
function splitRef(ref, baseUrl) {
  const [docPart, fragment = ''] = String(ref).split('#');
  const url = docPart ? new URL(docPart, baseUrl || SDM.listUrl).toString() : baseUrl;
  return { url, pointer: fragment };
}

function derefPointer(doc, pointer) {
  if (!pointer) return doc;
  let node = doc;
  for (const rawSeg of pointer.split('/')) {
    if (!rawSeg) continue;
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node == null || typeof node !== 'object') return null;
    node = node[seg];
  }
  return node === undefined ? null : node;
}

async function loadRef(ref, baseUrl) {
  const { url, pointer } = splitRef(ref, baseUrl);
  const doc = await fetchJsonOptional(url);
  if (!doc) return { node: null, url };
  return { node: derefPointer(doc, pointer), url };
}

/**
 * Walk a schema and collect every reachable property into `acc`.
 * Handles `$ref` (local + remote), `allOf`, `anyOf`/`oneOf` and plain `properties`.
 */
async function collectProperties(node, acc, baseUrl, depth = 0) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;

  if (node.$ref) {
    const { node: target, url } = await loadRef(node.$ref, baseUrl);
    await collectProperties(target, acc, url, depth + 1);
  }

  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    for (const sub of node[key] || []) await collectProperties(sub, acc, baseUrl, depth + 1);
  }

  for (const name of node.required || []) acc.required.add(name);

  for (const [name, prop] of Object.entries(node.properties || {})) {
    // The most specific definition (the one closest to the model) wins; the common
    // schemas reached through $ref only fill in what is still missing.
    acc.properties[name] = { ...(prop || {}), ...(acc.properties[name] || {}) };
    acc.origin[name] = acc.origin[name] || baseUrl;
  }
}

/** Resolve a property that is itself a `$ref` (common in per-repo *-schema.json files). */
async function resolveProperty(prop, baseUrl, depth = 0) {
  if (!prop || typeof prop !== 'object' || depth > MAX_DEPTH) return prop || {};
  if (!prop.$ref) return prop;

  const { node, url } = await loadRef(prop.$ref, baseUrl);
  if (!node) return prop;

  const resolved = await resolveProperty(node, url, depth + 1);
  const merged   = { ...resolved, ...prop };   // the referring site's own fields win
  delete merged.$ref;
  return merged;
}

/** NGSI-LD attribute kind — SDM encodes it as a prefix of the description. */
function detectNgsiType(name, prop) {
  const d = String((prop && prop.description) || '').trim();
  if (/^geoproperty\b/i.test(d))  return 'GeoProperty';
  if (/^relationship\b/i.test(d)) return 'Relationship';
  if (/^property\b/i.test(d))     return 'Property';
  if (name === 'location')        return 'GeoProperty';
  if (/^ref[A-Z]/.test(name))     return 'Relationship';
  return 'Property';
}

function detectJsonType(prop) {
  if (!prop) return '';
  if (prop.type) return Array.isArray(prop.type) ? prop.type[0] : prop.type;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const alt = (prop[key] || []).find(x => x && x.type);
    if (alt) return Array.isArray(alt.type) ? alt.type[0] : alt.type;
  }
  if (prop.properties) return 'object';
  if (prop.items)      return 'array';
  if (prop.enum)       return typeof prop.enum[0] === 'number' ? 'number' : 'string';
  return '';
}

function describeAttribute(name, prop, required) {
  const description = String(prop.description || '').trim();
  return {
    name,
    ngsiType:    detectNgsiType(name, prop),
    jsonType:    detectJsonType(prop),
    required:    required.has(name),
    // `id` and `type` are NGSI-LD structure, not mapping targets.
    structural:  name === 'id' || name === 'type',
    description: description.replace(/^(Geo)?Property\.\s*|^Relationship\.\s*/i, '').trim(),
    model:       (description.match(/Model:\s*'([^']+)'/) || [])[1] || null,
    units:       (description.match(/[Uu]nits?:\s*'([^']+)'/) || [])[1] || null,
    enum:        prop.enum || (prop.items && prop.items.enum) || null,
    format:      prop.format || null,
    subFields:   prop.properties ? Object.keys(prop.properties) : null,
  };
}

// ─── Model ───────────────────────────────────────────────────────────────────────

/**
 * Load one data model: flattened attributes, the IRI each short name expands to
 * (taken from the repo `@context`), a normalized example and the source links.
 *
 * `inlineSchema` lets the UI paste a schema by hand — useful offline, and for
 * private/organisation-specific models that are not in the public catalog.
 */
async function getModel({ repo, model, inlineSchema = null, withExample = true }) {
  if (!repo || !model) throw new Error('getModel: repo and model are required');

  const sUrl   = schemaUrl(repo, model);
  const schema = inlineSchema || await fetchJson(sUrl);

  const acc = { properties: {}, required: new Set(), origin: {} };
  await collectProperties(schema, acc, inlineSchema ? SDM.listUrl : sUrl);

  const attributes = [];
  for (const [name, rawProp] of Object.entries(acc.properties)) {
    const prop = await resolveProperty(rawProp, acc.origin[name] || sUrl);
    attributes.push(describeAttribute(name, prop, acc.required));
  }
  attributes.sort((a, b) =>
    Number(a.structural) - Number(b.structural) ||
    Number(b.required)   - Number(a.required)   ||
    a.name.localeCompare(b.name));

  // Short-name → IRI comes from the repo @context; only fall back when it is missing.
  // A pasted schema gets no IRI at all: it is not published under smartdatamodels.org,
  // so its terms must keep expanding under the operator's own iriBase.
  const ctxDoc = inlineSchema ? null : await fetchJsonOptional(contextUrl(repo));
  const terms  = (ctxDoc && ctxDoc['@context']) || {};
  for (const attr of attributes) {
    const iri = terms[attr.name];
    const ok  = typeof iri === 'string' && !iri.startsWith('@');
    attr.iri         = ok ? iri : (inlineSchema ? null : fallbackIri(repo, attr.name));
    attr.iriResolved = ok;
  }

  const typeIri = inlineSchema ? null
    : typeof terms[model] === 'string' ? terms[model]
    : fallbackIri(repo, model);
  const example = withExample && !inlineSchema ? await fetchJsonOptional(exampleUrl(repo, model)) : null;

  return {
    repo,
    model,
    title:       schema.title || model,
    description: schema.description || '',
    version:     schema.$schemaVersion || null,
    typeIri,
    attributes,
    example,
    links: {
      schema:  inlineSchema ? null : sUrl,
      context: inlineSchema ? null : contextUrl(repo),
      doc:     inlineSchema ? null : docUrl(repo, model),
    },
    offline: !!inlineSchema,
    cache:   inlineSchema ? null : cacheInfo(sUrl),
  };
}

// ─── NGSI-LD preview ─────────────────────────────────────────────────────────────

/** Best-effort GeoJSON for a value that is meant to land in a GeoProperty. */
function toGeoJson(value) {
  if (value && typeof value === 'object') {
    if (value.type && value.coordinates) return value;
    const lon = firstNumber(value.longitude, value.lon, value.lng, value.x);
    const lat = firstNumber(value.latitude,  value.lat, value.y);
    if (lon !== null && lat !== null) return { type: 'Point', coordinates: [lon, lat] };
  }
  return { type: 'Point', coordinates: [0, 0] };
}

function firstNumber(...candidates) {
  for (const c of candidates) if (typeof c === 'number' && Number.isFinite(c)) return c;
  return null;
}

/**
 * Build the normalized NGSI-LD entity a set of assignments would produce.
 * `assignments`: [{ attribute, ngsiType, value, observedAt?, unitCode? }]
 */
function buildEntityPreview({ entityId, entityType, assignments = [], contextUrls = [] }) {
  const entity = {
    id:   entityId   || 'urn:ngsi-ld:Example:001',
    type: entityType || 'Example',
  };

  for (const a of assignments) {
    if (!a || !a.attribute) continue;
    const ngsiType = a.ngsiType || 'Property';

    let node;
    if (ngsiType === 'Relationship') {
      node = { type: 'Relationship', object: String(a.value == null ? 'urn:ngsi-ld:Unknown:001' : a.value) };
    } else if (ngsiType === 'GeoProperty') {
      node = { type: 'GeoProperty', value: toGeoJson(a.value) };
    } else {
      node = { type: 'Property', value: a.value === undefined ? null : a.value };
    }

    if (a.unitCode)   node.unitCode   = a.unitCode;
    if (a.observedAt) node.observedAt = a.observedAt;
    entity[a.attribute] = node;
  }

  const ctx = contextUrls.filter(Boolean);
  entity['@context'] = ctx.length ? ctx : [`${SDM.rawBase}/data-models/${SDM.branch}/context.jsonld`];
  return entity;
}

module.exports = {
  getCatalog,
  searchCatalog,
  getModel,
  buildEntityPreview,
  warmCache,
  cacheInfo,
  cacheSize,
  // exported for tests / reuse
  schemaUrl,
  contextUrl,
  exampleUrl,
  docUrl,
  detectNgsiType,
  detectJsonType,
  toGeoJson,
};
