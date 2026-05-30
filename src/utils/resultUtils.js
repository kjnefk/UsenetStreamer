const { parseCommaList } = require('./config');
const { normalizeReleaseTitle, normalizeResolutionToken, normalizeIndexerToken } = require('./parsers');
const { getPublishMetadataFromResult, areReleasesWithinDays } = require('./publishInfo');

const DEDUPE_MAX_PUBLISH_DIFF_DAYS = 14;

function normalizeUsenetGroup(value) {
  if (!value) return '';
  return String(value).trim().toLowerCase();
}

function extractUsenetGroup(result) {
  if (!result || typeof result !== 'object') return '';
  return normalizeUsenetGroup(
    result.group
    || result.groups
    || result.usenetGroup
    || result?.release?.group
  );
}

function extractFileCount(result) {
  if (!result || typeof result !== 'object') return Number.POSITIVE_INFINITY;
  const raw = result.files ?? result.filecount ?? result.fileCount;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return Number.POSITIVE_INFINITY;
}

function parseAllowedResolutionList(rawValue) {
  const entries = parseCommaList(rawValue);
  if (!Array.isArray(entries) || entries.length === 0) return [];
  return entries
    .map((entry) => normalizeResolutionToken(entry))
    .filter(Boolean);
}

function parseResolutionLimitValue(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const normalized = String(rawValue).trim();
  if (!normalized) return null;
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function isResultFromPaidIndexer(result, paidTokens) {
  if (!result || !paidTokens || paidTokens.size === 0) return false;
  const tokens = [
    normalizeIndexerToken(result.indexerId || result.IndexerId),
    normalizeIndexerToken(result.indexer || result.Indexer),
  ].filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.some((token) => paidTokens.has(token));
}

// Dedupe modes:
//   'standard' — title + usenetGroup as bucket key, 14-day publish window inside
//                each bucket. Re-posts to different groups stay as separate
//                streams. This is the historical behavior.
//   'strict'   — normalized title only as bucket key, no publish window. Any
//                same-title release collapses into one regardless of group or
//                age. Removes more streams than standard.
const DEDUPE_MODES = new Set(['standard', 'strict']);

function dedupeResultsByTitle(results, paidTokens = new Set(), mode = 'standard') {
  if (!Array.isArray(results) || results.length === 0) return [];
  const dedupeMode = DEDUPE_MODES.has(mode) ? mode : 'standard';
  const useDateWindow = dedupeMode === 'standard';
  const useGroupInKey = dedupeMode === 'standard';
  const buckets = new Map();
  const deduped = [];
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const normalizedTitle = normalizeReleaseTitle(result.title);
    const publishMeta = getPublishMetadataFromResult(result);
    if (publishMeta.publishDateMs && !result.publishDateMs) {
      result.publishDateMs = publishMeta.publishDateMs;
    }
    if (publishMeta.publishDateIso && !result.publishDateIso) {
      result.publishDateIso = publishMeta.publishDateIso;
    }
    if ((publishMeta.ageDays ?? null) !== null && (result.ageDays === undefined || result.ageDays === null)) {
      result.ageDays = publishMeta.ageDays;
    }
    if (!normalizedTitle) {
      deduped.push(result);
      continue;
    }
    const usenetGroup = useGroupInKey ? extractUsenetGroup(result) : '';
    const bucketKey = usenetGroup ? `${normalizedTitle}|${usenetGroup}` : normalizedTitle;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = [];
      buckets.set(bucketKey, bucket);
    }
    const candidatePublish = publishMeta.publishDateMs ?? null;
    const candidateIsPaid = isResultFromPaidIndexer(result, paidTokens);
    const candidateFiles = extractFileCount(result);
    let matchedEntry = null;
    for (const entry of bucket) {
      // Standard mode requires the date window to match; strict mode collapses
      // any same-title entry already in the bucket regardless of age.
      if (!useDateWindow || areReleasesWithinDays(entry.publishDateMs ?? null, candidatePublish ?? null, DEDUPE_MAX_PUBLISH_DIFF_DAYS)) {
        matchedEntry = entry;
        break;
      }
    }
    if (!matchedEntry) {
      const entry = {
        publishDateMs: candidatePublish,
        isPaid: candidateIsPaid,
        fileCount: candidateFiles,
        result,
        listIndex: deduped.length,
      };
      bucket.push(entry);
      deduped.push(result);
      continue;
    }

    if (candidateIsPaid && !matchedEntry.isPaid) {
      matchedEntry.isPaid = true;
      matchedEntry.fileCount = candidateFiles;
      matchedEntry.result = result;
      deduped[matchedEntry.listIndex] = result;
      continue;
    }

    if (candidateIsPaid === matchedEntry.isPaid) {
      const existingFiles = Number.isFinite(matchedEntry.fileCount) ? matchedEntry.fileCount : Number.POSITIVE_INFINITY;
      if (candidateFiles < existingFiles) {
        matchedEntry.fileCount = candidateFiles;
        matchedEntry.result = result;
        deduped[matchedEntry.listIndex] = result;
      }
      continue;
    }
    // If we reach here, existing is paid and candidate is not — skip candidate
  }
  return deduped;
}

module.exports = {
  DEDUPE_MAX_PUBLISH_DIFF_DAYS,
  DEDUPE_MODES,
  normalizeUsenetGroup,
  extractUsenetGroup,
  extractFileCount,
  parseAllowedResolutionList,
  parseResolutionLimitValue,
  isResultFromPaidIndexer,
  dedupeResultsByTitle,
};
