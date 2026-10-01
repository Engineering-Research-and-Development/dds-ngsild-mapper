'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  rows: { topics: [], services: [], actions: [] },   // editable rows from /api/discovery
  output: { config: null, context: null },           // last generated objects
};

const KINDS = [
  { key: 'topics',   title: 'Topics' },
  { key: 'services', title: 'Services' },
  { key: 'actions',  title: 'Actions' },
];

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ─── Boot ──────────────────────────────────────────────────────────────────────
let sdmEnabled = true;   // mirrors SDM_ENABLED; set by loadConfigDefaults()

window.addEventListener('DOMContentLoaded', async () => {
  wireSourceTabs();
  wireSettingsToggle();
  wireButtons();
  wireSdm();
  await loadConfigDefaults();
  if (sdmEnabled) loadSdmCatalog();
});

async function loadConfigDefaults() {
  try {
    const { settings } = await api('/api/config', 'GET');
    $('#src-url').value         = settings.discoveryUrl || '';
    $('#set-iriBase').value     = settings.iriBase || '';
    $('#set-contextUri').value  = settings.contextUri || '';
    $('#set-domain').value      = settings.domain ?? 0;
    $('#set-typesDir').value    = settings.typesDir || '';
    $('#set-syncTimeout').value = settings.syncTimeout ?? 5000;
    $('#set-outConfig').value   = settings.outConfig || '';
    $('#set-outContext').value  = settings.outContext || '';
    // SDM_ENABLED=false (air-gapped deployments): drop the playground entirely.
    sdmEnabled = settings.sdmEnabled !== false;
    $('#sdm-card').classList.toggle('hidden', !sdmEnabled);
  } catch (e) {
    setStatus('#load-status', `Could not read defaults: ${e.message}`, 'err');
  }
}

// ─── Source tabs ─────────────────────────────────────────────────────────────────
let activeSource = 'url';
function wireSourceTabs() {
  // Scoped to this card: the Smart Data Models playground reuses the .tab styling.
  const tabs = $$('.source-tabs .tab');
  tabs.forEach(tab => tab.addEventListener('click', () => {
    activeSource = tab.dataset.source;
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    $$('.source-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== activeSource));
  }));
}

function wireSettingsToggle() {
  $('#settings-toggle').addEventListener('click', () => {
    $('#settings-card').classList.toggle('collapsed');
    $('#settings-grid').classList.toggle('hidden');
  });
}

function mappingMode() {
  const checked = document.querySelector('input[name="map-mode"]:checked');
  return checked ? checked.value : 'interactive';
}

function wireButtons() {
  $('#btn-load').addEventListener('click', loadDiscovery);
  $('#btn-generate').addEventListener('click', generate);

  $$('input[name="map-mode"]').forEach(r => r.addEventListener('change', () => {
    $('#mode-hint').textContent = mappingMode() === 'auto'
      ? 'Map everything with the suggested defaults and generate immediately.'
      : 'Review and edit each entry before generating.';
  }));

  $$('[data-bulk]').forEach(b => b.addEventListener('click', () => {
    const action = b.dataset.bulk;
    for (const { key } of KINDS) state.rows[key].forEach(r => { r.action = action; });
    renderTables();
  }));

  $$('[data-copy]').forEach(b => b.addEventListener('click', () => {
    const which = b.dataset.copy;
    const obj = state.output[which];
    if (obj) navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
  }));
  $$('[data-download]').forEach(b => b.addEventListener('click', () => {
    const which = b.dataset.download;
    const obj = state.output[which];
    if (!obj) return;
    const name = which === 'config' ? 'dds-config.json' : 'dds-context.jsonld';
    download(name, JSON.stringify(obj, null, 2));
  }));
}

// ─── Settings collection ─────────────────────────────────────────────────────────
function collectSettings() {
  return {
    iriBase:     $('#set-iriBase').value.trim(),
    contextUri:  $('#set-contextUri').value.trim(),
    domain:      Number($('#set-domain').value) || 0,
    typesDir:    $('#set-typesDir').value.trim(),
    syncTimeout: Number($('#set-syncTimeout').value) || 0,
    outConfig:   $('#set-outConfig').value.trim(),
    outContext:  $('#set-outContext').value.trim(),
    autoBlocklistLogs: $('#opt-blocklist-logs').checked,
  };
}

// ─── Load discovery ──────────────────────────────────────────────────────────────
async function loadDiscovery() {
  setStatus('#load-status', 'Loading…', '');
  try {
    const body = { settings: collectSettings() };

    if (activeSource === 'url') {
      const url = $('#src-url').value.trim();
      if (!url) throw new Error('enter a URL');
      body.url = url;
    } else if (activeSource === 'file') {
      const file = $('#src-file').files[0];
      if (!file) throw new Error('select a file');
      body.data = JSON.parse(await file.text());
    } else {
      const text = $('#src-paste').value.trim();
      if (!text) throw new Error('paste the discovery JSON');
      body.data = JSON.parse(text);
    }

    const res = await api('/api/discovery', 'POST', body);
    state.rows = res.rows;
    renderTables();
    $('#mapping-card').classList.remove('hidden');
    $('#output-card').classList.remove('hidden');
    onDiscoveryLoaded();
    const { topics, services, actions } = res.counts;

    if (mappingMode() === 'auto') {
      // Automatic: every row already defaults to Map with suggestions → generate now.
      setStatus('#load-status', `OK — ${topics} topics, ${services} services, ${actions} actions · auto-mapping…`, 'ok');
      await generate();
    } else {
      setStatus('#load-status', `OK — ${topics} topics, ${services} services, ${actions} actions`, 'ok');
    }
  } catch (e) {
    setStatus('#load-status', `Error: ${e.message}`, 'err');
  }
}

// ─── Render mapping tables ───────────────────────────────────────────────────────
function renderTables() {
  const container = $('#tables');
  container.innerHTML = '';

  for (const { key, title } of KINDS) {
    const rows = state.rows[key];
    if (!rows || rows.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'table-group';
    group.innerHTML = `
      <h3 class="group-title">${title} <span class="badge">${rows.length}</span></h3>
      <table>
        <thead><tr>
          <th>DDS name</th><th>Type</th><th>Action</th>
          <th>entityType</th><th>entityId</th><th>attribute</th>
        </tr></thead>
        <tbody></tbody>
      </table>`;
    const tbody = group.querySelector('tbody');
    rows.forEach((row, idx) => tbody.appendChild(renderRow(key, row, idx)));
    container.appendChild(group);
  }
}

function renderRow(kind, row, idx) {
  const tr = document.createElement('tr');
  tr.className = rowClass(row.action);

  // DDS name (+ log badge) + type
  const tdName = el('td', 'dds-name');
  const nameLine = el('div', 'dds-name-line');
  nameLine.textContent = row.ddsName;
  if (row.isLog) {
    const tag = el('span', 'log-badge');
    tag.textContent = 'log';
    tag.title = 'ROS 2 log topic — blocklisted by default';
    nameLine.append(' ', tag);
  }
  if (row.sdm) {
    const tag = el('span', 'sdm-badge');
    tag.textContent = 'SDM';
    tag.title = `Aligned to ${row.sdm.repo} / ${row.sdm.model}`;
    nameLine.append(' ', tag);
  }
  tdName.appendChild(nameLine);
  // Southbound POST payload placeholder(s), when discovery provided them (WS `parts`).
  if (Array.isArray(row.payloads) && row.payloads.length) {
    tdName.appendChild(renderPayloads(row.payloads));
  }
  const tdType = el('td', 'dds-type'); tdType.textContent = row.ddsTypeInfo || '—'; tdType.title = row.ddsTypeInfo || '';

  // action select
  const tdAction = el('td', 'col-action');
  const sel = document.createElement('select');
  sel.className = `action-select ${row.action}`;
  for (const opt of ['map', 'skip', 'blocklist']) {
    const o = document.createElement('option');
    o.value = opt; o.textContent = { map: 'Map', skip: 'Skip', blocklist: 'Blocklist' }[opt];
    if (opt === row.action) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    row.action = sel.value;
    sel.className = `action-select ${row.action}`;
    tr.className = rowClass(row.action);
  });
  tdAction.appendChild(sel);

  // Jump to the Smart Data Models playground with this endpoint already selected.
  if (sdmEnabled) {
    const sdmBtn = document.createElement('button');
    sdmBtn.className = 'reset-btn sdm-row-btn';
    sdmBtn.textContent = 'SDM';
    sdmBtn.title = 'Try this endpoint against a Smart Data Model';
    sdmBtn.addEventListener('click', () => openSdmFor(row));
    tdAction.appendChild(sdmBtn);
  }

  // editable fields with reset-to-suggestion
  const tdType2 = fieldCell(row, 'entityType', kind, idx);
  const tdId    = fieldCell(row, 'entityId',   kind, idx);
  const tdAttr  = fieldCell(row, 'attribute',  kind, idx);

  tr.append(tdName, tdType, tdAction, tdType2, tdId, tdAttr);
  return tr;
}

function fieldCell(row, field, kind, idx) {
  const td = el('td');
  const wrap = el('div', 'field-wrap');

  const input = document.createElement('input');
  input.type = 'text';
  input.value = row[field];
  input.addEventListener('input', () => { row[field] = input.value; });
  wrap.appendChild(input);

  const suggested = row.suggestions ? row.suggestions[field] : undefined;
  if (suggested !== undefined) {
    const reset = document.createElement('button');
    reset.className = 'reset-btn';
    reset.textContent = '↺';
    reset.title = `Suggestion: ${suggested}`;
    reset.addEventListener('click', () => { row[field] = suggested; input.value = suggested; });
    wrap.appendChild(reset);
  }

  td.appendChild(wrap);
  return td;
}

function rowClass(action) {
  return action === 'skip' ? 'row-skip' : action === 'blocklist' ? 'row-blocklist' : '';
}

// Collapsible preview of the southbound POST payload placeholder(s) for an endpoint.
// Each part is { label, details }; a topic has one unlabelled part, a service two
// ("Request"/"Reply"), an action three ("Goal Request"/"Feedback"/"Result Reply").
function renderPayloads(payloads) {
  const details = el('details', 'payloads');
  const summary = document.createElement('summary');
  summary.textContent = payloads.length > 1 ? `payload · ${payloads.length} parts` : 'payload';
  details.appendChild(summary);

  const wrap = el('div', 'payload-parts');
  for (const part of payloads) {
    const box = el('div', 'payload-part');
    if (part.label) {
      const lab = el('span', 'payload-label');
      lab.textContent = part.label;
      box.appendChild(lab);
    }
    const pre = document.createElement('pre');
    pre.textContent = formatDetails(part.details);
    box.appendChild(pre);
    wrap.appendChild(box);
  }
  details.appendChild(wrap);
  return details;
}

// Mirror the DDS Enabler dashboard: pretty-print the JSON placeholder, raw text fallback.
function formatDetails(details) {
  if (details == null || details === '') return '(placeholder not yet available)';
  try { return JSON.stringify(JSON.parse(details), null, 2); }
  catch (e) { return details; }
}

// ─── Generate ────────────────────────────────────────────────────────────────────
async function generate() {
  setStatus('#gen-status', 'Generating…', '');
  $('#errors').classList.add('hidden');
  try {
    const body = {
      settings: collectSettings(),
      rows: state.rows,
      write: $('#opt-write').checked,
    };
    const res = await api('/api/generate', 'POST', body, /* allow422 */ true);

    if (!res.ok) {
      showErrors(res.errors || ['unknown error']);
      setStatus('#gen-status', 'Validation failed', 'err');
      $('#output-grid').classList.add('hidden');
      return;
    }

    state.output.config  = res.config;
    state.output.context = res.context;
    $('#out-config').textContent  = JSON.stringify(res.config, null, 2);
    $('#out-context').textContent = JSON.stringify(res.context, null, 2);
    $('#output-grid').classList.remove('hidden');

    const msg = res.written
      ? `OK — saved to ${res.written.outConfig} and ${res.written.outContext}`
      : 'OK — preview generated';
    setStatus('#gen-status', msg, 'ok');
  } catch (e) {
    setStatus('#gen-status', `Error: ${e.message}`, 'err');
  }
}

function showErrors(errors) {
  const box = $('#errors');
  box.innerHTML = `<strong>Validation errors:</strong><ul>${
    errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')
  }</ul>`;
  box.classList.remove('hidden');
}

// ═══ Smart Data Models playground ════════════════════════════════════════════════
//
// Two directions are offered, because they answer different questions:
//
//   "Endpoints → attributes"      one DDS endpoint fills one attribute of one entity.
//                                 This is what dds-config.json expresses, so it can be
//                                 applied back to the mapping table.
//   "Payload fields → attributes" a what-if breakdown of one payload. Preview only —
//                                 the DDS bridge cannot split a payload across
//                                 attributes, so it is downloadable as a side-car.

const sdmState = {
  catalog:         null,   // last /api/sdm/catalog response
  model:           null,   // loaded model (attributes, IRIs, links)
  endpointMatches: [],     // rows of the "Endpoints → attributes" table
  fieldMatches:    [],     // rows of the "Payload fields → attributes" table
  fieldEndpoint:   null,   // mapping row the field view is looking at
  tab:             'endpoints',
  entity:          null,   // last NGSI-LD preview
};

function wireSdm() {
  const search = debounce(() => loadSdmCatalog(), 250);
  $('#sdm-q').addEventListener('input', search);
  $('#sdm-domain').addEventListener('change', () => loadSdmCatalog());

  $('#sdm-load-schema').addEventListener('click', loadPastedSchema);
  $('#sdm-attr-filter').addEventListener('input', () => renderSdmAttributes());

  $$('[data-sdm-tab]').forEach(tab => tab.addEventListener('click', () => {
    sdmState.tab = tab.dataset.sdmTab;
    $$('[data-sdm-tab]').forEach(t => t.classList.toggle('active', t === tab));
    $$('[data-sdm-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.sdmPane !== sdmState.tab));
    refreshSdmPreview();
  }));

  $('#sdm-rematch').addEventListener('click', runEndpointMatch);
  $('#sdm-apply').addEventListener('click', applySdmToMapping);
  $('#sdm-entity-id').addEventListener('input', debounce(refreshSdmPreview, 300));
  $('#sdm-endpoint-pick').addEventListener('change', runFieldMatch);

  $$('[data-copy-sdm]').forEach(b => b.addEventListener('click', () => {
    if (sdmState.entity) navigator.clipboard.writeText(JSON.stringify(sdmState.entity, null, 2));
  }));
  $$('[data-download-sdm]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.downloadSdm === 'mapping') return downloadSideCar();
    if (sdmState.entity) download('sdm-preview.jsonld', JSON.stringify(sdmState.entity, null, 2));
  }));
}

// ─── Catalog ─────────────────────────────────────────────────────────────────────

async function loadSdmCatalog() {
  const meta = $('#sdm-catalog-meta');
  try {
    const q      = $('#sdm-q').value.trim();
    const domain = $('#sdm-domain').value;
    const params = new URLSearchParams({ q, domain, limit: '80' });
    const res    = await api(`/api/sdm/catalog?${params}`, 'GET');

    sdmState.catalog = res;
    fillDomains(res.domains);
    renderSdmResults(res.entries);
    meta.textContent = (q || domain
      ? `${res.matched} of ${res.total} models match`
      : `${res.total} models · catalog updated ${String(res.updatedDate || '').slice(0, 10)}`)
      + cacheLabel(res.cache);
    meta.className = 'sdm-meta';
  } catch (e) {
    $('#sdm-results').innerHTML = '';
    meta.textContent = `${e.message} — you can still paste a schema below.`;
    meta.className = 'sdm-meta err';
  }
}

/** " · cached 4 min ago" — the catalog and every schema are served from a local cache. */
function cacheLabel(cache) {
  if (!cache || !cache.cached) return '';
  const mins = Math.round((cache.ageMs || 0) / 60000);
  const age  = mins < 1 ? 'just now'
    : mins < 60 ? `${mins} min ago`
    : `${Math.round(mins / 60)} h ago`;
  return ` · cached ${age}${cache.fresh ? '' : ' (stale, will refresh)'}`;
}

let domainsFilled = false;
function fillDomains(domains) {
  if (domainsFilled || !domains || !domains.length) return;
  const sel = $('#sdm-domain');
  for (const d of domains) {
    const o = document.createElement('option');
    o.value = d; o.textContent = d;
    sel.appendChild(o);
  }
  domainsFilled = true;
}

function renderSdmResults(entries) {
  const box = $('#sdm-results');
  box.innerHTML = '';
  if (!entries.length) { box.innerHTML = '<div class="sdm-empty">No model matches that search.</div>'; return; }

  for (const e of entries) {
    const item = el('button', 'sdm-item');
    item.innerHTML = `<span class="sdm-item-model">${escapeHtml(e.model)}</span>
      <span class="sdm-item-repo">${escapeHtml(e.repo.replace(/^dataModel\./, ''))}</span>
      <span class="sdm-item-domain">${escapeHtml((e.domains || []).join(', '))}</span>`;
    item.addEventListener('click', () => selectSdmModel(e.repo, e.model, item));
    box.appendChild(item);
  }
}

// ─── Model ───────────────────────────────────────────────────────────────────────

async function selectSdmModel(repo, model, itemEl) {
  $$('.sdm-item').forEach(i => i.classList.toggle('active', i === itemEl));
  $('#sdm-model-head').textContent = `Loading ${model}…`;
  $('#sdm-model-head').className = 'sdm-empty';
  try {
    const params = new URLSearchParams({ repo, model });
    sdmState.model = await api(`/api/sdm/model?${params}`, 'GET');
    onModelLoaded();
  } catch (e) {
    $('#sdm-model-head').textContent = `Cannot load ${model}: ${e.message}`;
    $('#sdm-model-head').className = 'sdm-empty err';
  }
}

async function loadPastedSchema() {
  const text = $('#sdm-schema').value.trim();
  if (!text) return;
  try {
    const schema = JSON.parse(text);
    sdmState.model = await api('/api/sdm/model', 'POST', { schema });
    $$('.sdm-item').forEach(i => i.classList.remove('active'));
    onModelLoaded();
  } catch (e) {
    $('#sdm-model-head').textContent = `Cannot load pasted schema: ${e.message}`;
    $('#sdm-model-head').className = 'sdm-empty err';
  }
}

function onModelLoaded() {
  renderSdmModelHead();
  $('#sdm-attr-filter').classList.remove('hidden');
  $('#sdm-attr-filter').value = '';
  renderSdmAttributes();
  $('#sdm-bench').classList.remove('hidden');

  const idField = $('#sdm-entity-id');
  if (!idField.value || /^urn:ngsi-ld:[^:]+:001$/.test(idField.value)) {
    idField.value = `urn:ngsi-ld:${sdmState.model.model}:001`;
  }
  fillEndpointPicker();
  runEndpointMatch();
}

function renderSdmModelHead() {
  const m    = sdmState.model;
  const head = $('#sdm-model-head');
  head.className = 'sdm-model-head';

  const links = [];
  if (m.links.doc)     links.push(`<a href="${m.links.doc}" target="_blank" rel="noopener">docs</a>`);
  if (m.links.schema)  links.push(`<a href="${m.links.schema}" target="_blank" rel="noopener">schema</a>`);
  if (m.links.context) links.push(`<a href="${m.links.context}" target="_blank" rel="noopener">@context</a>`);

  head.innerHTML = `
    <div class="sdm-model-title">${escapeHtml(m.model)}
      <span class="badge">${m.attributes.filter(a => !a.structural).length} attrs</span>
      ${m.offline ? '<span class="pill">pasted</span>' : ''}
    </div>
    <div class="sdm-model-repo">${escapeHtml(m.repo)}${m.version ? ` · v${escapeHtml(m.version)}` : ''}${escapeHtml(cacheLabel(m.cache))}</div>
    <div class="sdm-model-desc">${escapeHtml(m.description || m.title || '')}</div>
    <div class="sdm-model-links">${links.join(' · ')}</div>`;
}

function renderSdmAttributes() {
  const m   = sdmState.model;
  const box = $('#sdm-attrs');
  box.innerHTML = '';
  if (!m) return;

  const filter = $('#sdm-attr-filter').value.trim().toLowerCase();
  const attrs  = m.attributes.filter(a => !a.structural &&
    (!filter || a.name.toLowerCase().includes(filter) || (a.description || '').toLowerCase().includes(filter)));

  if (!attrs.length) { box.innerHTML = '<div class="sdm-empty">No attribute matches that filter.</div>'; return; }

  for (const a of attrs) {
    const row = el('div', 'sdm-attr');
    row.innerHTML = `
      <div class="sdm-attr-head">
        <span class="sdm-attr-name">${escapeHtml(a.name)}</span>
        <span class="sdm-attr-kind ${a.ngsiType.toLowerCase()}">${a.ngsiType}</span>
        ${a.jsonType ? `<span class="sdm-attr-type">${escapeHtml(a.jsonType)}</span>` : ''}
        ${a.required ? '<span class="sdm-attr-req">required</span>' : ''}
        ${a.units ? `<span class="sdm-attr-type">${escapeHtml(a.units)}</span>` : ''}
      </div>
      <div class="sdm-attr-desc">${escapeHtml(a.description || '')}</div>`;
    row.title = a.iri || 'no published IRI — expands under the configured IRI base';
    box.appendChild(row);
  }
}

// ─── Endpoints → attributes ──────────────────────────────────────────────────────

/** Rows worth offering as mapping sources: everything the operator has not blocklisted. */
function discoveredEndpoints() {
  const out = [];
  for (const { key } of KINDS) {
    for (const row of state.rows[key] || []) {
      if (row.action === 'blocklist') continue;
      out.push({ kind: row.kind, ddsName: row.ddsName, ddsTypeInfo: row.ddsTypeInfo, payloads: row.payloads });
    }
  }
  return out;
}

function findRow(ddsName) {
  for (const { key } of KINDS) {
    const hit = (state.rows[key] || []).find(r => r.ddsName === ddsName);
    if (hit) return hit;
  }
  return null;
}

async function runEndpointMatch() {
  if (!sdmState.model) return;
  const endpoints = discoveredEndpoints();
  const box = $('#sdm-endpoint-table');

  if (!endpoints.length) {
    box.innerHTML = '<div class="sdm-empty">Load a discovery source first — then its endpoints show up here.</div>';
    sdmState.endpointMatches = [];
    refreshSdmPreview();
    return;
  }

  try {
    const res = await api('/api/sdm/match', 'POST', {
      mode: 'endpoints',
      attributes: sdmState.model.attributes,
      endpoints,
    });
    sdmState.endpointMatches = res.endpoints;
    renderEndpointTable();
    refreshSdmPreview();
  } catch (e) {
    box.innerHTML = `<div class="sdm-empty err">${escapeHtml(e.message)}</div>`;
  }
}

function renderEndpointTable() {
  const box = $('#sdm-endpoint-table');
  box.innerHTML = '';

  const table = document.createElement('table');
  table.className = 'sdm-table';
  table.innerHTML = `
    <thead><tr>
      <th>DDS endpoint</th><th>Kind</th><th>Payload</th>
      <th>SDM attribute</th><th>Fit</th><th>Note</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  for (const m of sdmState.endpointMatches) {
    const tr = el('tr', m.chosen ? '' : 'row-skip');
    tr.append(
      tdText(m.ddsName, 'dds-name'),
      tdText(m.kind, 'dds-type'),
      tdText(m.fieldCount ? `${m.jsonType} · ${m.fieldCount} field${m.fieldCount > 1 ? 's' : ''}` : '—', 'dds-type'),
      tdSelect(m, () => { renderEndpointTable(); refreshSdmPreview(); }),
      tdScore(m.score),
      tdText(m.note || '', 'sdm-note'),
    );
    tbody.appendChild(tr);
  }

  box.appendChild(table);
}

/** Attribute picker: best suggestions first, then every other attribute of the model. */
function tdSelect(match, onChange) {
  const td  = el('td');
  const sel = document.createElement('select');
  sel.className = 'sdm-select';

  const none = document.createElement('option');
  none.value = ''; none.textContent = '— not mapped —';
  sel.appendChild(none);

  const suggested = (match.candidates || []).filter(c => c.score > 0);
  const names     = new Set(suggested.map(c => c.attribute));

  if (suggested.length) {
    const group = document.createElement('optgroup');
    group.label = 'Suggested';
    for (const c of suggested) {
      const o = document.createElement('option');
      o.value = c.attribute;
      o.textContent = `${c.attribute}  (${Math.round(c.score * 100)}%)`;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }

  const group = document.createElement('optgroup');
  group.label = 'All attributes';
  for (const a of sdmState.model.attributes) {
    if (a.structural || names.has(a.name)) continue;
    const o = document.createElement('option');
    o.value = a.name; o.textContent = `${a.name} · ${a.ngsiType}`;
    group.appendChild(o);
  }
  sel.appendChild(group);

  sel.value = match.chosen || '';
  sel.addEventListener('change', () => {
    match.chosen = sel.value;
    const hit = (match.candidates || []).find(c => c.attribute === sel.value);
    match.score = hit ? hit.score : (sel.value ? 1 : 0);
    match.note  = hit ? hit.note : '';
    onChange();
  });

  td.appendChild(sel);
  return td;
}

function tdText(text, cls) {
  const td = el('td', cls);
  td.textContent = text || '';
  td.title = text || '';
  return td;
}

function tdScore(score) {
  const td  = el('td', 'sdm-fit');
  const pct = Math.round((score || 0) * 100);
  const bar = el('div', 'sdm-bar');
  const fill = el('div', `sdm-bar-fill ${pct >= 70 ? 'good' : pct >= 45 ? 'fair' : 'weak'}`);
  fill.style.width = `${Math.max(2, pct)}%`;
  bar.appendChild(fill);
  td.appendChild(bar);
  const label = el('span', 'sdm-fit-label');
  label.textContent = `${pct}%`;
  td.appendChild(label);
  return td;
}

/** Write the chosen attributes back into the mapping table (section 3). */
function applySdmToMapping() {
  const m = sdmState.model;
  if (!m) return;

  const entityId = $('#sdm-entity-id').value.trim();
  if (!entityId) {
    setStatus('#sdm-apply-status', 'Set a target entityId first', 'err');
    return;
  }

  const byName = new Map(m.attributes.map(a => [a.name, a]));
  let applied = 0;

  for (const match of sdmState.endpointMatches) {
    if (!match.chosen) continue;
    const row = findRow(match.ddsName);
    if (!row) continue;

    row.action     = 'map';
    row.entityType = m.model;
    row.entityId   = entityId;
    row.attribute  = match.chosen;
    row.sdm = {
      repo:         m.repo,
      model:        m.model,
      typeIri:      m.typeIri,
      attributeIri: (byName.get(match.chosen) || {}).iri || null,
    };
    applied++;
  }

  if ($('#sdm-apply-context').checked && m.links.context) {
    $('#set-contextUri').value = m.links.context;
  }

  renderTables();
  setStatus('#sdm-apply-status',
    applied
      ? `Applied ${applied} endpoint${applied > 1 ? 's' : ''} to ${m.model} — review them in section 3`
      : 'Nothing to apply: no endpoint has an attribute selected',
    applied ? 'ok' : 'err');
}

// ─── Payload fields → attributes ─────────────────────────────────────────────────

function fillEndpointPicker() {
  const sel = $('#sdm-endpoint-pick');
  const previous = sel.value;
  sel.innerHTML = '';

  for (const { key, title } of KINDS) {
    const rows = (state.rows[key] || []).filter(r => r.action !== 'blocklist');
    if (!rows.length) continue;
    const group = document.createElement('optgroup');
    group.label = title;
    for (const r of rows) {
      const o = document.createElement('option');
      o.value = r.ddsName;
      o.textContent = r.payloads ? r.ddsName : `${r.ddsName} (no payload placeholder)`;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }

  if (previous) sel.value = previous;
  if (sel.options.length) runFieldMatch();
}

async function runFieldMatch() {
  const box = $('#sdm-field-table');
  if (!sdmState.model) return;

  const row = findRow($('#sdm-endpoint-pick').value);
  sdmState.fieldEndpoint = row;

  if (!row) {
    box.innerHTML = '<div class="sdm-empty">Load a discovery source to inspect a payload.</div>';
    sdmState.fieldMatches = [];
    return;
  }
  if (!row.payloads || !row.payloads.length) {
    box.innerHTML = '<div class="sdm-empty">This endpoint has no payload placeholder — the discovery backend did not send one.</div>';
    sdmState.fieldMatches = [];
    refreshSdmPreview();
    return;
  }

  try {
    const res = await api('/api/sdm/match', 'POST', {
      mode: 'fields',
      attributes: sdmState.model.attributes,
      payloads: row.payloads,
    });
    sdmState.fieldMatches = res.fields;
    renderFieldTable();
    refreshSdmPreview();
  } catch (e) {
    box.innerHTML = `<div class="sdm-empty err">${escapeHtml(e.message)}</div>`;
  }
}

function renderFieldTable() {
  const box = $('#sdm-field-table');
  box.innerHTML = '';

  const table = document.createElement('table');
  table.className = 'sdm-table';
  table.innerHTML = `
    <thead><tr>
      <th>Payload field</th><th>Part</th><th>Type</th><th>Sample</th>
      <th>SDM attribute</th><th>Fit</th><th>Note</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  for (const f of sdmState.fieldMatches) {
    const tr = el('tr', f.chosen ? '' : 'row-skip');
    tr.append(
      tdText(f.path, 'dds-name'),
      tdText(f.label || '—', 'dds-type'),
      tdText(f.jsonType, 'dds-type'),
      tdText(shortSample(f.sample), 'dds-type'),
      tdSelect(f, () => { renderFieldTable(); refreshSdmPreview(); }),
      tdScore(f.score),
      tdText(f.note || '', 'sdm-note'),
    );
    tbody.appendChild(tr);
  }

  box.appendChild(table);
}

function shortSample(value) {
  if (value === undefined) return '';
  const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}

// ─── Preview ─────────────────────────────────────────────────────────────────────

const refreshSdmPreview = debounce(async () => {
  const m = sdmState.model;
  if (!m) return;

  const assignments = sdmState.tab === 'fields'
    ? sdmState.fieldMatches
        .filter(f => f.chosen)
        .map(f => ({ attribute: f.chosen, value: f.sample, jsonType: f.jsonType, path: f.path }))
    : sdmState.endpointMatches
        .filter(e => e.chosen)
        .map(e => ({
          attribute: e.chosen,
          // The bridge moves the whole payload into the attribute, so the placeholder
          // (when discovery provided one) is exactly what the value would look like.
          value:     endpointSampleValue(e.ddsName),
          jsonType:  e.jsonType,
          ddsName:   e.ddsName,
        }));

  try {
    const res = await api('/api/sdm/preview', 'POST', {
      attributes:  m.attributes,
      entityId:    $('#sdm-entity-id').value.trim(),
      entityType:  m.model,
      contextUrls: [m.links.context].filter(Boolean),
      assignments,
    });
    sdmState.entity = res.entity;
    $('#sdm-entity').textContent = JSON.stringify(res.entity, null, 2);
    renderSdmReport(res.report);
  } catch (e) {
    $('#sdm-entity').textContent = `Preview failed: ${e.message}`;
  }
}, 200);

function endpointSampleValue(ddsName) {
  const row = findRow(ddsName);
  if (!row || !row.payloads || !row.payloads.length) return null;
  const raw = row.payloads[0].details;
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return raw; }
}

function renderSdmReport(report) {
  const box = $('#sdm-report');
  const bits = [];

  bits.push(`<span class="sdm-chip ok">${report.assigned} attribute${report.assigned === 1 ? '' : 's'} filled</span>`);
  if (report.unassigned) bits.push(`<span class="sdm-chip">${report.unassigned} source${report.unassigned === 1 ? '' : 's'} unmapped</span>`);
  if (report.missingRequired.length) {
    bits.push(`<span class="sdm-chip warn">required and still empty: ${escapeHtml(report.missingRequired.join(', '))}</span>`);
  }
  for (const w of report.warnings) bits.push(`<span class="sdm-chip warn">${escapeHtml(w)}</span>`);

  box.innerHTML = bits.join(' ');
}

// ─── Entry points from the rest of the UI ────────────────────────────────────────

function onDiscoveryLoaded() {
  if (!sdmState.model) return;
  fillEndpointPicker();
  runEndpointMatch();
}

/** The per-row "SDM" button: focus the playground on one endpoint. */
function openSdmFor(row) {
  $('#sdm-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!sdmState.model) {
    $('#sdm-q').value = row.entityType || '';
    loadSdmCatalog();
    return;
  }
  const tab = $('[data-sdm-tab="fields"]');
  tab.click();
  $('#sdm-endpoint-pick').value = row.ddsName;
  runFieldMatch();
}

function downloadSideCar() {
  const m = sdmState.model;
  if (!m) return;

  const byName = new Map(m.attributes.map(a => [a.name, a]));
  const sideCar = {
    generatedBy: 'dds-ngsi-mapper',
    dataModel: {
      repo:    m.repo,
      model:   m.model,
      typeIri: m.typeIri,
      schema:  m.links.schema,
      context: m.links.context,
    },
    entityId: $('#sdm-entity-id').value.trim(),
    endpoint: sdmState.fieldEndpoint
      ? { kind: sdmState.fieldEndpoint.kind, ddsName: sdmState.fieldEndpoint.ddsName }
      : null,
    fieldMappings: sdmState.fieldMatches.filter(f => f.chosen).map(f => ({
      path:         f.path,
      part:         f.label || null,
      jsonType:     f.jsonType,
      attribute:    f.chosen,
      ngsiType:     (byName.get(f.chosen) || {}).ngsiType || 'Property',
      attributeIri: (byName.get(f.chosen) || {}).iri || null,
      fit:          f.score,
    })),
    preview: sdmState.entity,
    note: 'Field-level mapping is a design aid: dds-config.json moves a whole DDS payload into a single NGSI-LD attribute.',
  };
  download('sdm-mapping.json', JSON.stringify(sideCar, null, 2));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function api(path, method, body, allow422) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(allow422 && res.status === 422)) {
    throw new Error(data.error || (data.errors && data.errors.join('; ')) || `HTTP ${res.status}`);
  }
  return data;
}

function setStatus(sel, text, cls) {
  const el = $(sel);
  el.textContent = text;
  el.className = `status ${cls || ''}`.trim();
}

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
