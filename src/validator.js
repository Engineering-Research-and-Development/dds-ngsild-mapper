'use strict';

/**
 * Validates the mapping state before writing output.
 * Returns an array of error strings; empty = valid.
 *
 * Rules (from §7 of the spec):
 *  R7a — entityId must be a valid URI (URN or URL).
 *  R7b — attribute and entityType must be non-empty and URL-safe.
 *  R7c — No two rows in the same category share the same entityId+attribute pair.
 *  R7d — (Implicit) No short name can map to two IRIs; since IRI = iriBase + urlSafe(name),
 *         this holds automatically as long as urlSafe is deterministic.
 */
function validate(state) {
  const errors = [];

  for (const kind of ['topics', 'services', 'actions']) {
    const seen = new Map(); // "entityId::attribute" → ddsName

    for (const row of state.rows[kind]) {
      if (!row.mapped) continue;

      // R7a
      if (!isValidUri(row.entityId)) {
        errors.push(`[${kind}] "${row.ddsName}": entityId "${row.entityId}" is not a valid URI`);
      }

      // R7b — attribute
      if (!row.attribute || !row.attribute.trim()) {
        errors.push(`[${kind}] "${row.ddsName}": attribute is empty`);
      } else if (!isUrlSafe(row.attribute)) {
        errors.push(`[${kind}] "${row.ddsName}": attribute "${row.attribute}" contains characters not safe for IRI generation`);
      }

      // R7b — entityType (optional field, only validate if set)
      if (row.entityType && !isUrlSafe(row.entityType)) {
        errors.push(`[${kind}] "${row.ddsName}": entityType "${row.entityType}" contains characters not safe for IRI generation`);
      }

      // R7c
      const collisionKey = `${row.entityId}::${row.attribute}`;
      if (seen.has(collisionKey)) {
        errors.push(
          `[${kind}] Collision: entityId="${row.entityId}" attribute="${row.attribute}" ` +
          `is shared by "${seen.get(collisionKey)}" and "${row.ddsName}"`
        );
      } else {
        seen.set(collisionKey, row.ddsName);
      }
    }
  }

  return errors;
}

function isValidUri(str) {
  if (!str) return false;
  // Standard URL (http/https/ftp/etc.)
  try {
    new URL(str);
    return true;
  } catch { /* fall through to URN check */ }
  // URN: urn:<nid>:<nss>  (NGSI-LD entity ids are typically URNs)
  return /^urn:[a-zA-Z0-9][a-zA-Z0-9-]{0,31}:[^\s]+$/.test(str);
}

function isUrlSafe(name) {
  // Allow characters that produce a valid IRI local part
  return /^[a-zA-Z0-9._~-]+$/.test(name);
}

module.exports = { validate, isValidUri, isUrlSafe };
