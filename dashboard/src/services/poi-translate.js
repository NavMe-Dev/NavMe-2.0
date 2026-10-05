/**
 * Translate labels into multilingual columns used by NavMe tables.
 *
 * Providers (in order, with session circuit-breaker):
 *  1. Google gtx (free, IP rate-limited)
 *  2. MyMemory (CORS; higher daily quota if VITE_MYMEMORY_EMAIL is set)
 *
 * Each Save translates name (and description if present) into all NAVME_LANGUAGES.
 * Failed languages keep the source text so the POI/facility can still be saved.
 * Click Save later to retry translations once the providers recover.
 */

import { NAVME_LANGUAGES } from '../config/languages.js';

const GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';
const MYMEMORY_TRANSLATE_URL = 'https://api.mymemory.translated.net/get';
/** Google / long-text chunk size (URL length safe). */
const MAX_CHUNK_CHARS = 4500;
/** MyMemory free API prefers short queries (~500 chars). */
const MYMEMORY_MAX_CHARS = 450;
/** Parallel language / chunk requests — 1 avoids provider rate limits under Save. */
const TRANSLATE_CONCURRENCY = 1;
/** Backoff (ms) after HTTP 429 before retrying a Google chunk. */
const TRANSLATE_429_BACKOFF_MS = 1800;
/** Fewer Google retries — MyMemory covers sustained 429s. */
const GOOGLE_MAX_ATTEMPTS = 2;
/** Small pause between successful language requests. */
const TRANSLATE_LANG_GAP_MS = 250;
/** After a Google 429, skip Google for this long (ms). Keep short so Save/Translate can recover. */
const GOOGLE_COOLDOWN_MS = 90 * 1000;
/** Optional email unlocks MyMemory’s higher free daily quota (~50k chars/day). */
const MYMEMORY_EMAIL = String(import.meta.env.VITE_MYMEMORY_EMAIL ?? '').trim();
/** In-session cache: source|target|text → translation. */
const translateCache = new Map();
/** @type {number} epoch ms until which Google is skipped after 429 */
let googleCooldownUntil = 0;
/** Language codes that failed on the most recent buildTranslationFields call(s). */
let lastFailedLangs = [];
/** `${source}::${langCode}` accepted even when translation equals source (proper nouns). */
const acceptedSameAsSource = new Set();

/**
 * Languages that could not be translated since the last consume.
 * @returns {string[]}
 */
export function consumeTranslationFailures() {
  const failed = [...new Set(lastFailedLangs)];
  lastFailedLangs = [];
  return failed;
}

/**
 * True when a language field is empty or still the English/source fallback.
 * @param {unknown} value
 * @param {unknown} sourceText
 * @param {string} [langCode]
 */
export function isUntranslated(value, sourceText, langCode = '') {
  const v = String(value ?? '').trim();
  const s = String(sourceText ?? '').trim();
  if (!v) return true;
  if (!s) return false;
  if (v.localeCompare(s, undefined, { sensitivity: 'accent' }) !== 0) return false;
  // Same spelling as English can be valid (e.g. Tornado). Skip once a provider accepted it.
  if (langCode && acceptedSameAsSource.has(`${s}::${langCode}`)) return false;
  return true;
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @param {string} columnPrefix
 * @param {string | null} [jsonField]
 * @returns {Record<string, string>}
 */
export function langMapFromRow(row, columnPrefix, jsonField = null) {
  const json =
    jsonField && row?.[jsonField] && typeof row[jsonField] === 'object' && !Array.isArray(row[jsonField])
      ? /** @type {Record<string, unknown>} */ (row[jsonField])
      : {};
  /** @type {Record<string, string>} */
  const map = {};
  for (const lang of NAVME_LANGUAGES) {
    const col = String(row?.[`${columnPrefix}_${lang.code}`] ?? '').trim();
    const fromJson = String(json?.[lang.code] ?? '').trim();
    map[lang.code] = col || fromJson;
  }
  return map;
}

/**
 * @param {Record<string, unknown> | null | undefined} fields
 * @param {string} columnPrefix
 * @param {string | null} [jsonField]
 * @returns {Record<string, string>}
 */
export function langMapFromTranslationFields(fields, columnPrefix, jsonField = null) {
  return langMapFromRow(fields, columnPrefix, jsonField);
}

/**
 * @param {Record<string, string> | null | undefined} existing
 * @param {string} sourceText
 * @param {string} [sourceLang='en']
 * @returns {string[]}
 */
export function missingTranslationLangs(existing, sourceText, sourceLang = 'en') {
  const sourceCode = String(sourceLang || 'en').trim();
  return NAVME_LANGUAGES.filter((lang) => {
    if (lang.code === sourceCode || lang.apiCode === sourceCode) return false;
    return isUntranslated(existing?.[lang.code], sourceText, lang.code);
  }).map((lang) => lang.code);
}

/**
 * Run async work over items with a fixed concurrency pool (preserves result order).
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(items, concurrency, fn) {
  const results = /** @type {R[]} */ (new Array(items.length));
  let next = 0;
  const workers = Math.min(Math.max(1, concurrency), Math.max(1, items.length));

  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function utf8ByteLength(str) {
  return new TextEncoder().encode(str).length;
}

/**
 * Split text into chunks that stay under maxChars, preferring
 * paragraph / sentence / whitespace boundaries.
 * @param {string} text
 * @param {number} [maxChars=MAX_CHUNK_CHARS]
 * @returns {string[]}
 */
function chunkText(text, maxChars = MAX_CHUNK_CHARS) {
  const limit = Math.max(80, maxChars);
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks = [];
  let remaining = trimmed;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    let cut =
      Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
        window.lastIndexOf('; '),
        window.lastIndexOf(', '),
        window.lastIndexOf(' '),
      );

    if (cut < limit * 0.4) {
      cut = limit;
    } else if (
      remaining[cut] === '.' ||
      remaining[cut] === '!' ||
      remaining[cut] === '?' ||
      remaining[cut] === ';' ||
      remaining[cut] === ','
    ) {
      cut += 1;
    } else if (remaining.slice(cut, cut + 2) === '. ') {
      cut += 2;
    }

    const piece = remaining.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map Google-style codes to MyMemory langpair codes. */
function myMemoryLang(code) {
  const c = String(code || '').trim();
  if (c === 'zh-CN' || c === 'zh') return 'zh-CN';
  if (c === 'en') return 'en';
  return c;
}

/**
 * Translate one chunk via Google gtx.
 * @param {string} text
 * @param {string} sourceCode
 * @param {string} targetCode
 */
/**
 * Prefer same-origin Vite proxy in local/dev so browser IP rate-limits hit less often.
 * @param {string} text
 * @param {string} sourceCode
 * @param {string} targetCode
 */
async function translateChunkGoogle(text, sourceCode, targetCode) {
  if (Date.now() < googleCooldownUntil) {
    throw new Error('Google translation cooling down after rate-limit');
  }

  const params = new URLSearchParams({
    client: 'gtx',
    sl: sourceCode,
    tl: targetCode,
    dt: 't',
    q: text,
  });
  const directUrl = `${GOOGLE_TRANSLATE_URL}?${params.toString()}`;
  const proxyUrl = `/api/translate-google?${params.toString()}`;

  let lastStatus = 0;
  for (let attempt = 0; attempt < GOOGLE_MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetch(proxyUrl);
      // Local proxy missing or failing — fall back to Google directly.
      if (!res.ok) {
        res = await fetch(directUrl);
      }
    } catch {
      res = await fetch(directUrl);
    }
    lastStatus = res.status;
    if (res.ok) {
      const data = await res.json();
      if (!Array.isArray(data?.[0])) {
        throw new Error('Unexpected Google translation response');
      }

      const translated = data[0]
        .map((part) => (Array.isArray(part) ? part[0] : ''))
        .join('')
        .trim();

      if (!translated) throw new Error('Google translation empty');
      // Proper nouns sometimes come back unchanged — treat as failure so MyMemory can try.
      if (
        sourceCode !== targetCode &&
        translated.localeCompare(text, undefined, { sensitivity: 'accent' }) === 0
      ) {
        throw new Error('Google returned untranslated text');
      }
      return translated;
    }
    if (res.status === 429) {
      googleCooldownUntil = Date.now() + GOOGLE_COOLDOWN_MS;
      if (attempt + 1 < GOOGLE_MAX_ATTEMPTS) {
        await sleep(TRANSLATE_429_BACKOFF_MS * (attempt + 1));
        continue;
      }
      throw new Error('Google translation HTTP 429');
    }
    throw new Error(`Google translation HTTP ${res.status}`);
  }
  throw new Error(`Google translation HTTP ${lastStatus || 429}`);
}

/**
 * CORS-friendly fallback when Google is rate-limited.
 * Long text is split to MyMemory’s short query limit.
 * @param {string} text
 * @param {string} sourceCode
 * @param {string} targetCode
 */
async function translateChunkMyMemory(text, sourceCode, targetCode) {
  const pieces = chunkText(text, MYMEMORY_MAX_CHARS);
  const parts = [];
  for (let i = 0; i < pieces.length; i++) {
    const params = new URLSearchParams({
      q: pieces[i],
      langpair: `${myMemoryLang(sourceCode)}|${myMemoryLang(targetCode)}`,
    });
    if (MYMEMORY_EMAIL) {
      params.set('de', MYMEMORY_EMAIL);
    }
    const res = await fetch(`${MYMEMORY_TRANSLATE_URL}?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`MyMemory HTTP ${res.status}`);
    }
    const data = await res.json();
    const status = Number(data?.responseStatus ?? 0);
    const translated = String(data?.responseData?.translatedText ?? '').trim();
    if (status === 429 || /QUOTA|LIMIT/i.test(String(data?.responseDetails ?? ''))) {
      throw new Error('MyMemory daily quota reached — set VITE_MYMEMORY_EMAIL or wait until tomorrow');
    }
    if (status !== 200 || !translated) {
      throw new Error(`MyMemory failed: ${data?.responseDetails || status || 'empty'}`);
    }
    // Allow identical text (shared proper nouns). Reject only low-confidence copies.
    if (
      translated.localeCompare(pieces[i], undefined, { sensitivity: 'accent' }) === 0 &&
      sourceCode !== targetCode
    ) {
      const match = Number(data?.responseData?.match ?? 0);
      if (match > 0 && match < 0.35) {
        throw new Error('MyMemory returned untranslated text');
      }
    }
    parts.push(translated);
    if (i + 1 < pieces.length) await sleep(120);
  }
  return parts.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Google first (unless cooling down), then MyMemory. Cached per session.
 * @param {string} text
 * @param {string} sourceCode
 * @param {string} targetCode
 */
async function translateChunk(text, sourceCode, targetCode) {
  const cacheKey = `${sourceCode}|${targetCode}|${text}`;
  if (translateCache.has(cacheKey)) {
    const cached = translateCache.get(cacheKey);
    // Never keep a bad "same as English" cache entry — that blocked retries.
    if (
      sourceCode === targetCode ||
      String(cached ?? '').localeCompare(text, undefined, { sensitivity: 'accent' }) !== 0
    ) {
      return cached;
    }
    translateCache.delete(cacheKey);
  }

  const googleReady = Date.now() >= googleCooldownUntil;
  let out;
  if (googleReady) {
    try {
      out = await translateChunkGoogle(text, sourceCode, targetCode);
    } catch (googleErr) {
      console.warn('[translate] Google failed, trying MyMemory:', googleErr?.message || googleErr);
      out = await translateChunkMyMemory(text, sourceCode, targetCode);
    }
  } else {
    try {
      out = await translateChunkMyMemory(text, sourceCode, targetCode);
    } catch (mmErr) {
      // Cooldown may have expired mid-Save — one last Google attempt.
      if (Date.now() >= googleCooldownUntil) {
        try {
          out = await translateChunkGoogle(text, sourceCode, targetCode);
        } catch {
          throw mmErr;
        }
      } else {
        throw mmErr;
      }
    }
  }

  // MyMemory may correctly return the same string for shared proper nouns (e.g. Tornado).
  // Only reject empty results here.
  if (!String(out ?? '').trim()) {
    throw new Error('Translation providers returned empty text');
  }

  translateCache.set(cacheKey, out);
  return out;
}

/**
 * Translate one chunk with a single retry on failure.
 * @param {string} text
 * @param {string} sourceCode
 * @param {string} targetCode
 */
async function translateChunkWithRetry(text, sourceCode, targetCode) {
  try {
    return await translateChunk(text, sourceCode, targetCode);
  } catch (err) {
    console.warn('[translate] chunk retry', err);
    await sleep(800);
    return translateChunk(text, sourceCode, targetCode);
  }
}

/**
 * Translate full text (chunked when needed). Chunks run in parallel, joined in order.
 * @param {string} text
 * @param {string} sourceCode
 * @param {string} targetCode
 */
async function translateSegment(text, sourceCode, targetCode) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return trimmed;
  if (sourceCode === targetCode) return trimmed;

  const pieces = chunkText(trimmed);
  if (pieces.length === 1) {
    return translateChunkWithRetry(pieces[0], sourceCode, targetCode);
  }

  const out = await mapPool(pieces, TRANSLATE_CONCURRENCY, (piece) =>
    translateChunkWithRetry(piece, sourceCode, targetCode),
  );

  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() || trimmed;
}

/**
 * @param {string} text
 * @param {{ columnPrefix: string, jsonField?: string | null, sourceLang?: string, includeEnus?: boolean, existing?: Record<string, string> | null }} opts
 */
export async function buildTranslationFields(
  text,
  { columnPrefix, jsonField = null, sourceLang = 'en', includeEnus = false, existing = null },
) {
  const sourceEntry =
    NAVME_LANGUAGES.find((lang) => lang.code === String(sourceLang || 'en').trim()) ??
    NAVME_LANGUAGES[0];
  const source = sourceEntry.apiCode;
  const trimmed = String(text ?? '').trim();
  const existingMap = existing && typeof existing === 'object' ? existing : {};

  /** @type {Record<string, string>} */
  const translations = {};

  if (!trimmed) {
    for (const lang of NAVME_LANGUAGES) {
      translations[lang.code] = '';
    }
  } else {
    translations[sourceEntry.code] = trimmed;
    const failed = [];
    // Sequential (concurrency 1) so Save does not trip Google rate limits.
    for (let i = 0; i < NAVME_LANGUAGES.length; i++) {
      const lang = NAVME_LANGUAGES[i];
      if (lang.apiCode === source || lang.code === sourceEntry.code) {
        translations[lang.code] = trimmed;
        continue;
      }
      if (!isUntranslated(existingMap[lang.code], trimmed, lang.code)) {
        translations[lang.code] = String(existingMap[lang.code]).trim();
        continue;
      }
      try {
        translations[lang.code] = await translateSegment(trimmed, source, lang.apiCode);
        if (
          String(translations[lang.code] ?? '').localeCompare(trimmed, undefined, {
            sensitivity: 'accent',
          }) === 0
        ) {
          acceptedSameAsSource.add(`${trimmed}::${lang.code}`);
        }
      } catch (err) {
        console.warn(`[translate] ${lang.code} failed:`, err);
        failed.push(lang.code);
        // Do NOT copy English into other language columns — that looked "saved" but wasn't translated.
        const prior = String(existingMap[lang.code] ?? '').trim();
        translations[lang.code] = prior && !isUntranslated(prior, trimmed, lang.code) ? prior : '';
      }
      if (i + 1 < NAVME_LANGUAGES.length) {
        await sleep(TRANSLATE_LANG_GAP_MS);
      }
    }
    if (failed.length > 0) {
      lastFailedLangs.push(...failed);
      console.warn(
        `[translate] ${failed.join(', ')} failed (Google rate-limited and fallback failed). Saved source text; click Translate later to retry.`,
      );
    }
  }

  const fields = {};
  if (jsonField) {
    fields[jsonField] = translations;
  }
  for (const lang of NAVME_LANGUAGES) {
    fields[`${columnPrefix}_${lang.code}`] = translations[lang.code];
  }
  // Legacy `*_enus` columns on facilities / some NavMe tables.
  if (includeEnus) {
    fields[`${columnPrefix}_enus`] = translations.en ?? trimmed;
  }
  return fields;
}

/**
 * Translate a POI name into all navme_pois language fields.
 *
 * @param {string} poiName
 * @param {string} [sourceLang='en']
 */
export async function buildPoiTranslationFields(poiName, sourceLang = 'en', options = {}) {
  return buildTranslationFields(poiName, {
    columnPrefix: 'poi_name',
    jsonField: 'poi_names',
    sourceLang,
    existing: options.existing,
  });
}

/**
 * Translate a POI description into all navme_pois language fields.
 *
 * @param {string} description
 * @param {string} [sourceLang='en']
 */
export async function buildPoiDescriptionTranslationFields(description, sourceLang = 'en', options = {}) {
  return buildTranslationFields(description, {
    columnPrefix: 'description',
    jsonField: 'descriptions',
    sourceLang,
    existing: options.existing,
  });
}

/**
 * Translate a category name into all navme_categories language fields.
 *
 * @param {string} categoryName
 * @param {string} [sourceLang='en']
 */
export async function buildCategoryTranslationFields(categoryName, sourceLang = 'en') {
  return buildTranslationFields(categoryName, {
    columnPrefix: 'name',
    jsonField: 'category_names',
    sourceLang,
  });
}

/**
 * Translate a floor name into all navme_floors language fields.
 *
 * @param {string} floorName
 * @param {string} [sourceLang='en']
 */
export async function buildFloorTranslationFields(floorName, sourceLang = 'en') {
  return buildTranslationFields(floorName, {
    columnPrefix: 'name',
    jsonField: 'floor_names',
    sourceLang,
  });
}

/**
 * Facility name → `facility_name_<lang>` (+ legacy `facility_name_enus`).
 * @param {string} name
 * @param {string} [sourceLang='en']
 */
export async function buildFacilityNameTranslationFields(name, sourceLang = 'en') {
  return buildTranslationFields(name, {
    columnPrefix: 'facility_name',
    sourceLang,
    includeEnus: true,
  });
}

/**
 * Facility category → `facility_category_<lang>` (+ enus).
 * @param {string} category
 * @param {string} [sourceLang='en']
 */
export async function buildFacilityCategoryTranslationFields(category, sourceLang = 'en') {
  return buildTranslationFields(category, {
    columnPrefix: 'facility_category',
    sourceLang,
    includeEnus: true,
  });
}

/**
 * Facility group → `facility_group_<lang>` (+ enus).
 * @param {string} group
 * @param {string} [sourceLang='en']
 */
export async function buildFacilityGroupTranslationFields(group, sourceLang = 'en') {
  return buildTranslationFields(group, {
    columnPrefix: 'facility_group',
    sourceLang,
    includeEnus: true,
  });
}

/**
 * Translate name + category + group for a facility row.
 * @param {{ facility_name?: string, facility_category?: string, facility_group?: string }} facility
 * @param {string} [sourceLang='en']
 */
export async function buildFacilityTranslationFields(facility, sourceLang = 'en') {
  const [nameFields, categoryFields, groupFields] = await Promise.all([
    buildFacilityNameTranslationFields(facility?.facility_name ?? '', sourceLang),
    buildFacilityCategoryTranslationFields(facility?.facility_category ?? '', sourceLang),
    buildFacilityGroupTranslationFields(facility?.facility_group ?? '', sourceLang),
  ]);
  return { ...nameFields, ...categoryFields, ...groupFields };
}

/** Exported for tests / scripts. */
export const __test = { chunkText, utf8ByteLength, translateSegment, mapPool };
