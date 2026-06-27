// One-time, run-once startup migrations that retire legacy config fields.
//
// Some old config keys were dropped from the admin UI but kept being read by
// the backend, so their stale values silently affected results with no way for
// the user to see or clear them. Each migration here folds the legacy value
// into the current, visible field and then DELETES the legacy key — so it stops
// applying and never re-migrates (idempotent: once the key is gone it's a
// no-op). All migrations operate only on keys present in runtime-env.json (so
// they can be deleted); values supplied solely via Docker/.env are left alone.
//
// Covered legacy fields:
//   1. NZB_RELEASE_EXCLUSIONS  → NZB_EXCLUDED_QUALITIES/ENCODES/VISUAL_TAGS/
//      REGEX_PATTERNS. The old release-type keyword list (cam, telesync, hdtv,
//      webrip, xvid, 3d, …) was applied as a *title* regex, where a bare "cam"
//      matched "Off Campus" and dropped every result. Hidden + additive +
//      buggy. (global + per-profile)
//   2. NZB_MIN_RESULT_SIZE_MB  → NZB_MIN_RESULT_SIZE_GB. The MB knob fed a
//      *separate, additive* min-size filter that the visible "Min Size (GB)"
//      field did not override — a stale large MB value silently dropped results
//      with no UI to see/clear it.

const { PARSE_REGEX, matchPattern, matchMultiplePatterns } = require('../metadata/releaseClassifier');

// Same release-name boundary the classifier uses: a term is a whole token when
// preceded by start/separator and followed by separator/end. So "cam" hits
// ".CAM." / " CAM " but never "Campus".
function boundedRegexLiteral(term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `/(?<![^\\s\\[(_\\-.,])(${escaped})(?=[\\s\\)\\]_.\\-,]|$)/i`;
}

// Classify a bare legacy term against the canonical regex tables directly
// (NOT classifyRelease, which strips the parsed title and would blank a
// single-token input). Returns { field, value }.
function classifyTerm(term) {
  const t = String(term || '').trim();
  if (!t) return null;
  const quality = matchPattern(t, PARSE_REGEX.qualities);
  if (quality) return { field: 'qualities', value: quality };
  const encode = matchPattern(t, PARSE_REGEX.encodes);
  if (encode) return { field: 'encodes', value: encode };
  const visual = matchMultiplePatterns(t, PARSE_REGEX.visualTags);
  if (visual.length) return { field: 'visualTags', value: visual[0] };
  return { field: 'regex', value: boundedRegexLiteral(t) };
}

function splitCsv(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function splitLines(value) {
  return String(value || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

// Union, preserving existing order/casing, case-insensitive dedup.
function mergeUnique(existing, additions) {
  const out = [];
  const seen = new Set();
  for (const v of [...existing, ...additions]) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

const SUFFIXES = {
  legacy: 'RELEASE_EXCLUSIONS',
  qualities: 'EXCLUDED_QUALITIES',
  encodes: 'EXCLUDED_ENCODES',
  visualTags: 'EXCLUDED_VISUAL_TAGS',
  regex: 'EXCLUDED_REGEX_PATTERNS',
};

// prefix is 'NZB_' for the global set, 'NZB_PROFILE_<NN>_' for a profile set.
function keysFor(prefix) {
  const out = {};
  for (const [k, suffix] of Object.entries(SUFFIXES)) out[k] = `${prefix}${suffix}`;
  return out;
}

// Migrate one key set into `updates`. Returns true if anything changed.
function migrateGroup(values, keys, updates) {
  // Only migrate when the legacy key actually lives in runtime-env (so we can
  // delete it). undefined means it's absent or Docker/.env-only → leave alone.
  if (!Object.prototype.hasOwnProperty.call(values, keys.legacy)) return false;
  const terms = splitCsv(values[keys.legacy]);

  // Present but empty → just retire the key.
  if (terms.length === 0) {
    if (values[keys.legacy] === '') { updates[keys.legacy] = null; return true; }
    updates[keys.legacy] = null;
    return true;
  }

  const add = { qualities: [], encodes: [], visualTags: [], regex: [] };
  for (const term of terms) {
    const c = classifyTerm(term);
    if (c) add[c.field].push(c.value);
  }

  // Read current target value from pending updates first, else runtime-env.
  const cur = (key) => (Object.prototype.hasOwnProperty.call(updates, key) ? updates[key] : values[key]);

  if (add.qualities.length) updates[keys.qualities] = mergeUnique(splitCsv(cur(keys.qualities)), add.qualities).join(', ');
  if (add.encodes.length) updates[keys.encodes] = mergeUnique(splitCsv(cur(keys.encodes)), add.encodes).join(', ');
  if (add.visualTags.length) updates[keys.visualTags] = mergeUnique(splitCsv(cur(keys.visualTags)), add.visualTags).join(', ');
  if (add.regex.length) updates[keys.regex] = mergeUnique(splitLines(cur(keys.regex)), add.regex).join('\n');

  updates[keys.legacy] = null; // DELETE — idempotent: next run sees no legacy key.
  return true;
}

/**
 * Build a runtime-env update patch that retires every Release-Exclusions key
 * (global + per-profile) found in `values`. Returns the patch, or null if there
 * is nothing to migrate.
 * @param {object} values - runtime-env values (from getRuntimeEnv())
 * @returns {object|null} updates suitable for updateRuntimeEnv (null deletes a key)
 */
function migrateReleaseExclusions(values) {
  if (!values || typeof values !== 'object') return null;
  const updates = {};
  let changed = false;
  for (const key of Object.keys(values)) {
    let prefix = null;
    if (key === 'NZB_RELEASE_EXCLUSIONS') prefix = 'NZB_';
    else {
      const m = key.match(/^(NZB_PROFILE_\d+_)RELEASE_EXCLUSIONS$/);
      if (m) prefix = m[1];
    }
    if (!prefix) continue;
    if (migrateGroup(values, keysFor(prefix), updates)) changed = true;
  }
  return changed ? updates : null;
}

// --- NZB_MIN_RESULT_SIZE_MB → NZB_MIN_RESULT_SIZE_GB -----------------------
// The MB knob feeds an independent, additive min-size filter (the visible "Min
// Size (GB)" field does NOT replace it). Fold an explicitly-set MB value into
// the GB field (keeping the larger of the two) and delete the MB key. Values at
// or below the 45 MB baseline floor (the default junk filter the code keeps
// regardless) carry no real user intent, so we just drop the key.
function migrateMinResultSize(values) {
  const KEY_MB = 'NZB_MIN_RESULT_SIZE_MB';
  const KEY_GB = 'NZB_MIN_RESULT_SIZE_GB';
  if (!Object.prototype.hasOwnProperty.call(values, KEY_MB)) return null;
  const updates = {};
  const mb = Number.parseFloat(String(values[KEY_MB]).trim());
  if (Number.isFinite(mb) && mb > 45) {
    const gbFromMb = mb / 1024;
    const curGb = Number.parseFloat(values[KEY_GB]);
    const newGb = Math.max(Number.isFinite(curGb) && curGb > 0 ? curGb : 0, gbFromMb);
    if (newGb > 0) updates[KEY_GB] = String(Number(newGb.toFixed(2)));
  }
  updates[KEY_MB] = null; // retire the hidden additive MB floor override
  return updates;
}

/**
 * Run every startup migration and return a single combined runtime-env update
 * patch (null deletes a key), or null if nothing needs migrating. Each migration
 * touches a disjoint key set, so their patches merge cleanly.
 * @param {object} values - runtime-env values (from getRuntimeEnv())
 * @returns {object|null}
 */
function runStartupMigrations(values) {
  if (!values || typeof values !== 'object') return null;
  const updates = {};
  let changed = false;
  for (const migrate of [migrateReleaseExclusions, migrateMinResultSize]) {
    const patch = migrate(values);
    if (patch && Object.keys(patch).length) {
      Object.assign(updates, patch);
      changed = true;
    }
  }
  return changed ? updates : null;
}

module.exports = {
  runStartupMigrations,
  migrateReleaseExclusions,
  migrateMinResultSize,
  classifyTerm,
  boundedRegexLiteral,
};
