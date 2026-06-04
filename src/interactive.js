'use strict';

const readline = require('readline');

/** Wraps rl.question in a Promise. */
function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

/**
 * Interactive mapping loop.
 * For each discovered row the operator chooses: map / skip / defaults / blocklist.
 * Returns the updated state.
 */
async function runInteractive(state, settings) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  printBanner(settings);

  // Collect entity IDs already used so we can suggest them (R3)
  const usedEntityIds = collectUsedEntityIds(state);

  for (const kind of ['topics', 'services', 'actions']) {
    const rows = state.rows[kind];
    if (rows.length === 0) continue;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(` ${kind.toUpperCase()}  (${rows.length} entries)`);
    console.log('─'.repeat(60));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      console.log(`\n[${i + 1}/${rows.length}]  ${row.ddsName}`);
      console.log(`  type : ${row.ddsTypeInfo || '—'}`);
      if (row.mapped) {
        console.log(`  state: mapped → entityId=${row.entityId}  type=${row.entityType}  attr=${row.attribute}`);
      } else {
        console.log(`  state: unmapped   (defaults: entityId=${row.entityId}  type=${row.entityType}  attr=${row.attribute})`);
      }

      const cmd = await ask(rl,
        '  [m]ap/edit  [d]efaults  [s]kip  [b]locklist  [Enter]=keep  [q]uit > '
      );
      const c = cmd.trim().toLowerCase();

      if (c === 'q') {
        console.log('\nExiting interactive mode early.');
        rl.close();
        applyBlocklist(state);
        return state;
      }

      if (c === 's') {
        row.mapped = false;
        row.blocklisted = false;
        continue;
      }

      if (c === 'b') {
        row.mapped = false;
        row.blocklisted = true;
        console.log(`  → queued for blocklist`);
        continue;
      }

      if (c === 'd') {
        row.mapped = true;
        row.blocklisted = false;
        console.log(`  → mapped with defaults`);
        continue;
      }

      if (c === 'm') {
        row.mapped = true;
        row.blocklisted = false;
        await editRow(rl, row, usedEntityIds);
        if (!usedEntityIds.includes(row.entityId)) usedEntityIds.push(row.entityId);
        continue;
      }

      // Enter = keep current state silently
    }
  }

  rl.close();
  applyBlocklist(state);
  return state;
}

/** Prompts the operator to fill / overwrite entityId, entityType, attribute. */
async function editRow(rl, row, usedEntityIds) {
  if (usedEntityIds.length > 0) {
    console.log(`  Known entityIds: ${usedEntityIds.join('  ')}`);
  }

  const newId   = await ask(rl, `  entityId   [${row.entityId}]: `);
  const newType = await ask(rl, `  entityType [${row.entityType}]: `);
  const newAttr = await ask(rl, `  attribute  [${row.attribute}]: `);

  if (newId.trim())   row.entityId   = newId.trim();
  if (newType.trim()) row.entityType = newType.trim();
  if (newAttr.trim()) row.attribute  = newAttr.trim();

  console.log(`  → entityId=${row.entityId}  type=${row.entityType}  attr=${row.attribute}`);
}

/** Writes blocklisted rows into ddsmodule.dds.blocklist. */
function applyBlocklist(state) {
  const blocklisted = [
    ...state.rows.topics,
    ...state.rows.services,
    ...state.rows.actions,
  ].filter(r => r.blocklisted).map(r => r.ddsName);

  if (blocklisted.length === 0) return;

  const bl = state.ddsmodule.dds.blocklist;
  // Remove placeholder if it's still there
  const phIdx = bl.findIndex(e => e.name === 'add_blocked_topics_here');
  if (phIdx !== -1) bl.splice(phIdx, 1);
  for (const name of blocklisted) {
    if (!bl.some(e => e.name === name)) bl.push({ name });
  }
  console.log(`\nAdded ${blocklisted.length} entry/entries to the DDS blocklist.`);
}

function collectUsedEntityIds(state) {
  const ids = new Set();
  for (const kind of ['topics', 'services', 'actions']) {
    for (const row of state.rows[kind]) {
      if (row.mapped && row.entityId !== 'urn:ngsi-ld:dds:default') ids.add(row.entityId);
    }
  }
  return [...ids];
}

function printBanner(settings) {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║          DDS → NGSI-LD Interactive Mapper                ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  IRI base   : ${settings.iriBase}`);
  console.log(`  DDS domain : ${settings.domain}`);
  console.log(`  Types dir  : ${settings.typesDir}`);
  console.log('\nFor each entry choose an action:');
  console.log('  [m]ap/edit   — set entityId, entityType, attribute');
  console.log('  [d]efaults   — accept pre-filled defaults');
  console.log('  [s]kip       — do not include in output');
  console.log('  [b]locklist  — exclude from DDS Enabler entirely');
  console.log('  [Enter]      — keep current state');
  console.log('  [q]uit       — stop prompting, save what we have so far');
}

module.exports = { runInteractive };
