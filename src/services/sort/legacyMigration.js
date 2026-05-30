// Converts the existing UsenetStreamer config shape into the engine's
// normalized sort-criteria + preferred-lists form.
//
// Existing env vars (preserved, source of truth for legacy installs):
//   NZB_SORT_ORDER             - comma-separated keys (e.g. "language,quality,size,files")
//                                Treated as the "global" list (default for all types).
//   NZB_SORT_ORDER_MOVIES      - per-type override; empty falls back to NZB_SORT_ORDER
//   NZB_SORT_ORDER_SERIES      - per-type override; empty falls back to NZB_SORT_ORDER
//   NZB_SORT_ORDER_ANIME       - per-type override; empty falls back to NZB_SORT_ORDER
//   NZB_PREFERRED_LANGUAGE     - comma-separated language display names
//   NZB_PREFERRED_QUALITIES    - comma-separated quality tokens
//   NZB_PREFERRED_RELEASE_GROUPS
//   NZB_PREFERRED_VISUAL_TAGS
//   NZB_PREFERRED_AUDIO_TAGS
//   NZB_PREFERRED_ENCODES
//   NZB_PREFERRED_KEYWORDS
//
// Output is a userConfig object compatible with src/services/sort/sortEngine.js.
//
// The legacy key set differs slightly from the engine's normalized names:
//   legacy `release_group` → `releaseGroup`
//   legacy `visual_tag`    → `visualTag`
//   legacy `audio_tag`     → `audioTag`
//   legacy `date`          → `age`
// All other key names are the same.

const LEGACY_KEY_TO_ENGINE = {
  language: 'language',
  release_group: 'releaseGroup',
  size: 'size',
  resolution: 'resolution',
  quality: 'quality',
  encode: 'encode',
  visual_tag: 'visualTag',
  audio_tag: 'audioTag',
  audio_channel: 'audioChannel',
  // Note: no `bitrate` mapping — bitrate is a numeric filter only, not a sort
  // key (it would order identically to `size` for a single title). A legacy
  // NZB_SORT_ORDER token of `bitrate` is silently dropped here.
  keyword: 'keyword',
  date: 'age',
  files: 'files',
};

// Keys where ascending = better in legacy semantics (used when the user has
// no explicit `:direction` suffix on the key).
const LEGACY_ASC_KEYS = new Set(['files']);

function inferDirection(legacyKey, explicitDirection) {
  if (explicitDirection === 'asc' || explicitDirection === 'desc') return explicitDirection;
  return LEGACY_ASC_KEYS.has(legacyKey) ? 'asc' : 'desc';
}

function splitCsv(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined) return [];
  return String(value)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
}

// Accepts both legacy format ("size,language,files") and new format with
// per-key direction ("size:desc,language:desc,files:asc"). Unknown keys are
// dropped silently.
function migrateSortOrder(sortOrderRaw) {
  const tokens = splitCsv(sortOrderRaw);
  const criteria = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const [keyRaw, dirRaw] = lower.split(':');
    const engineKey = LEGACY_KEY_TO_ENGINE[keyRaw];
    if (!engineKey) continue;
    criteria.push({ key: engineKey, direction: inferDirection(keyRaw, dirRaw) });
  }
  return criteria;
}

/**
 * Build a userConfig in the engine's normalized shape from the addon's
 * existing legacy env/config.
 *
 * @param {object} source - typically process.env or a runtime-env values object
 * @returns {object} userConfig with { sortCriteria, preferred }
 */
// When NZB_SORT_ORDER is empty, fall back to the same defaults the old engine
// used so existing users who relied solely on NZB_SORT_MODE keep their order.
function defaultsForLegacyMode(modeRaw) {
  const mode = (modeRaw || 'quality_then_size').toString().trim().toLowerCase();
  if (mode === 'language_quality_size') {
    return [
      { key: 'language', direction: 'desc' },
      { key: 'resolution', direction: 'desc' },
      { key: 'size', direction: 'desc' },
    ];
  }
  // 'custom_priority' uses NZB_SORT_ORDER directly (handled above).
  // Any other value → old default compareQualityThenSize behavior.
  return [
    { key: 'resolution', direction: 'desc' },
    { key: 'size', direction: 'desc' },
  ];
}

function buildConfigFromLegacy(source = {}) {
  const sortOrderRaw = source.NZB_SORT_ORDER || '';
  let globalCriteria = migrateSortOrder(sortOrderRaw);
  if (globalCriteria.length === 0) {
    globalCriteria = defaultsForLegacyMode(source.NZB_SORT_MODE);
  }

  const moviesCriteria = migrateSortOrder(source.NZB_SORT_ORDER_MOVIES || '');
  const seriesCriteria = migrateSortOrder(source.NZB_SORT_ORDER_SERIES || '');
  const animeCriteria = migrateSortOrder(source.NZB_SORT_ORDER_ANIME || '');

  const preferred = {
    languages: splitCsv(source.NZB_PREFERRED_LANGUAGE),
    qualities: splitCsv(source.NZB_PREFERRED_QUALITIES),
    encodes: splitCsv(source.NZB_PREFERRED_ENCODES),
    releaseGroups: splitCsv(source.NZB_PREFERRED_RELEASE_GROUPS),
    visualTags: splitCsv(source.NZB_PREFERRED_VISUAL_TAGS),
    audioTags: splitCsv(source.NZB_PREFERRED_AUDIO_TAGS),
    audioChannels: splitCsv(source.NZB_PREFERRED_AUDIO_CHANNELS),
    resolutions: splitCsv(source.NZB_ALLOWED_RESOLUTIONS),
  };

  return {
    sortCriteria: {
      global: globalCriteria,
      movies: moviesCriteria,
      series: seriesCriteria,
      anime: animeCriteria,
    },
    preferred,
  };
}

module.exports = {
  buildConfigFromLegacy,
  migrateSortOrder,
  splitCsv,
  LEGACY_KEY_TO_ENGINE,
};
