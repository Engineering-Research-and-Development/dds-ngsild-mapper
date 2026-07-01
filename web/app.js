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
window.addEventListener('DOMContentLoaded', async () => {
  wireSourceTabs();
  wireSettingsToggle();
  wireButtons();
  await loadConfigDefaults();
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
  } catch (e) {
    setStatus('#load-status', `Could not read defaults: ${e.message}`, 'err');
  }
}

// ─── Source tabs ─────────────────────────────────────────────────────────────────
let activeSource = 'url';
function wireSourceTabs() {
  $$('.tab').forEach(tab => tab.addEventListener('click', () => {
    activeSource = tab.dataset.source;
    $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
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

// ─── Helpers ─────────────────────────────────────────────────────────────────────
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
