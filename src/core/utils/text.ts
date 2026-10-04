/**
 * src/core/utils/text.ts
 *
 * String manipulation, fuzzy matching, Levenshtein distance, number formatting,
 * and OCR JSON parsing utilities.
 * Extracted from gm-utils.js as part of Ticket 3.2 modularization.
 */

export const MAX_NUMERIC = 9999999999;

export type AppRole = 'super_admin' | 'server_admin' | 'guild_admin' | 'member';

/**
 * THE escaping boundary for this app. Every dynamic value interpolated into
 * markup must pass through this function.
 *
 * Escapes `& < > " ' \``. The backtick matters: without it a value landing in a
 * template-literal context can break out of it.
 *
 * Nullish input yields `''`, never the strings `"null"` / `"undefined"` -- a
 * missing value must render as nothing, not as the word "null" on screen.
 *
 * There used to be a second, byte-for-byte copy of this in
 * `src/core/api/supabase.ts`, kept "byte-for-byte equivalent to gm-utils.js"
 * because `window.GM.escapeHTML` was reassigned to it on every page load. That
 * legacy script no longer exists, and the two copies had already drifted: this
 * one stringified nullish input while the other returned `''`. A duplicated
 * security boundary always drifts eventually, so they were merged here, keeping
 * the safer nullish behaviour.
 */
export function escapeHTML(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

/** Returns a validation error key, or null when the pseudo is valid. */
export function validatePseudo(pseudo: unknown): string | null {
  if (typeof pseudo !== 'string') return 'validation_pseudo_invalid';
  const v = pseudo.trim();
  if (v.length === 0) return 'validation_pseudo_empty';
  if (v.length > 32) return 'validation_pseudo_too_long';
  // Reject HTML/JS-dangerous characters and control characters.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (/[<>"'`&\\/\x00-\x1F\x7F]/.test(v)) return 'validation_pseudo_invalid_chars';
  return null;
}

/** Returns a validation error key, or null when the UID is valid (optional). */
export function validateUid(uid: unknown): string | null {
  if (uid == null || uid === '') return null;
  if (typeof uid !== 'string') return 'validation_uid_invalid';
  const v = uid.trim();
  if (v.length === 0) return null;
  if (!/^[0-9]+$/.test(v)) return 'validation_uid_not_numeric';
  if (v.length < 6) return 'validation_uid_too_short';
  if (v.length > 10) return 'validation_uid_too_long';
  return null;
}

/** Strict canonical role normalization: only canonical roles recognized; legacy ranks fall back to member. */
export function normalizeRole(r?: string | null): AppRole {
  if (!r) return 'member';
  const s = String(r).toLowerCase().trim();
  if (s === 'super_admin') return 'super_admin';
  if (s === 'server_admin') return 'server_admin';
  if (s === 'guild_admin') return 'guild_admin';
  if (s === 'member') return 'member';
  return 'member';
}

/**
 * Formats a number with spaces as thousands separators up to MAX_NUMERIC.
 * e.g. 1000000 -> "1 000 000"
 */
export function formatNumber(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '';
  const num = typeof n === 'number' ? n : parseInt(String(n).replace(/\D/g, ''), 10);
  if (isNaN(num)) return '';
  const clamped = num > MAX_NUMERIC ? MAX_NUMERIC : num;
  return String(clamped).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Compact display form for very large scores (event scores up to 9,999,999,999):
 * thousands "123.4K", millions "12.3M", billions "9.9B", dropping the decimal
 * when exact (2M not 2.0M). Values round DOWN so the visible compact number
 * never overstates the exact figure carried in a title/aria-label by callers.
 * Small numbers fall back to the grouped formatNumber() form.
 */
export function formatCompactNumber(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '';
  const num = typeof n === 'number' ? n : parseInt(String(n).replace(/\D/g, ''), 10);
  if (isNaN(num)) return '';
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return String(Math.floor(num / 100_000_000) / 10) + 'B';
  if (abs >= 1_000_000) return String(Math.floor(num / 100_000) / 10) + 'M';
  if (abs >= 1_000) return String(Math.floor(num / 100) / 10) + 'K';
  return String(num);
}

/**
 * Parses numeric string digits clamped up to MAX_NUMERIC.
 */
export function parseNumber(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined || s === '') return null;
  const digits = String(s).replace(/\D/g, '');
  if (digits === '') return null;
  const num = parseInt(digits, 10);
  if (isNaN(num)) return null;
  return Math.min(num, MAX_NUMERIC);
}

/**
 * Formats power numbers into compact units (e.g. 1.5B, 25.0M, 150.0K).
 */
export function formatPower(val: number | string | null | undefined): string {
  if (!val) return '-';
  const num = typeof val === 'number' ? val : parseInt(String(val), 10) || 0;
  if (num >= 1000000000) return (num / 1000000000).toFixed(1) + 'B';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return String(num);
}

/**
 * Generates 2-letter avatar initials (camelCase-aware).
 * "HawkTuah" -> "HT", "StarWarrior99" -> "SW", "lower_case" -> "LC", "ab" -> "AB"
 */
export function avatarInit(pseudo?: string | null): string {
  if (!pseudo) return '?';
  const s = String(pseudo).trim();
  const parts = s.split(/(?=[A-Z])|[\s_\-.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return s.slice(0, 2).toUpperCase();
}

/**
 * Strips configured guild tag brackets and prefixes cleanly from player pseudo.
 */
export function cleanPlayerPseudo(rawPseudo?: string | null, guildTag?: string | null): string {
  if (!rawPseudo || typeof rawPseudo !== 'string') return '';
  let clean = rawPseudo.trim();
  if (guildTag) {
    const tagClean = guildTag.replace(/[[\]]/g, '').trim();
    if (tagClean) {
      const escapedTag = tagClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const tagRegex = new RegExp('^\\s*\\[?' + escapedTag + '\\]?\\s*[-_:]?\\s*', 'i');
      clean = clean.replace(tagRegex, '').trim();
    }
  }
  clean = clean.replace(/^\[[^\]]+\]\s*/, '').trim();
  return clean || rawPseudo.trim();
}

/**
 * Computes standard Levenshtein distance between two strings.
 */
export function levenshteinDistance(a?: string | null, b?: string | null): number {
  if (!a) return b ? b.length : 0;
  if (!b) return a ? a.length : 0;
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Computes normalized similarity ratio between two strings (0.0 to 1.0).
 */
export function calculateStringSimilarity(str1?: string | null, str2?: string | null): number {
  if (!str1 || !str2) return 0;
  const s1 = String(str1).toLowerCase().trim();
  const s2 = String(str2).toLowerCase().trim();
  if (s1 === s2) return 1.0;

  const clean1 = s1.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/[^a-z0-9]/gi, '');
  const clean2 = s2.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/[^a-z0-9]/gi, '');
  if (clean1 && clean1 === clean2) return 0.95;

  const len1 = s1.length;
  const len2 = s2.length;
  const maxLen = Math.max(len1, len2);
  if (maxLen === 0) return 1.0;

  const dist = levenshteinDistance(s1, s2);
  let sim = 1.0 - dist / maxLen;

  const cleanMax = Math.max(clean1.length, clean2.length);
  if (cleanMax > 0) {
    const cleanDist = levenshteinDistance(clean1, clean2);
    const cleanSim = 1.0 - cleanDist / cleanMax;
    if (cleanSim > sim) sim = cleanSim;
  }

  return sim;
}

export type MemberMatchType = 'exact' | 'clean_tag' | 'normalized' | 'fuzzy';

export interface BestMatchingMemberResult<T> {
  member: T;
  matchType: MemberMatchType;
  score: number;
}

/**
 * Finds the closest matching member in a roster using exact, tag-stripped,
 * normalized alphanumeric, or Levenshtein fuzzy similarity.
 */
export function findBestMatchingMember<T extends { pseudo?: string | null }>(
  ocrPseudo?: string | null,
  members?: T[] | null,
  guildTag?: string | null
): BestMatchingMemberResult<T> | null {
  if (!ocrPseudo || !members || !Array.isArray(members) || members.length === 0) return null;
  const target = String(ocrPseudo).trim().toLowerCase();

  const exact = members.find((m) => m.pseudo && m.pseudo.trim().toLowerCase() === target);
  if (exact) return { member: exact, matchType: 'exact', score: 1.0 };

  const cleanTarget = cleanPlayerPseudo(ocrPseudo, guildTag).toLowerCase().trim();
  if (cleanTarget && cleanTarget !== target) {
    const exactClean = members.find((m) => m.pseudo && m.pseudo.trim().toLowerCase() === cleanTarget);
    if (exactClean) return { member: exactClean, matchType: 'clean_tag', score: 0.98 };
  }

  const targetClean = (cleanTarget || target).replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/[^a-z0-9]/gi, '');
  if (targetClean.length >= 3) {
    const normMatch = members.find((m) => {
      const mClean = (m.pseudo || '')
        .trim()
        .toLowerCase()
        .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
        .replace(/[^a-z0-9]/gi, '');
      return mClean === targetClean;
    });
    if (normMatch) return { member: normMatch, matchType: 'normalized', score: 0.95 };
  }

  let bestMember: T | null = null;
  let bestScore = 0;

  members.forEach((m) => {
    if (!m || !m.pseudo) return;
    const score = calculateStringSimilarity(cleanTarget || ocrPseudo, m.pseudo);
    if (score > bestScore) {
      bestScore = score;
      bestMember = m;
    }
  });

  if (bestMember && bestScore >= 0.75) {
    return { member: bestMember, matchType: 'fuzzy', score: bestScore };
  }

  return null;
}

/**
 * Parses JSON output from Gemini/OCR models, handling markdown fences and surrounding commentary.
 */
export function parseGeminiJson<T = unknown>(jsonText?: string | null): T | null {
  if (!jsonText) return null;
  const cleaned = String(jsonText)
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    const firstObj = cleaned.indexOf('{');
    const lastObj = cleaned.lastIndexOf('}');
    const firstArr = cleaned.indexOf('[');
    const lastArr = cleaned.lastIndexOf(']');

    let start = -1;
    let end = -1;

    if (firstObj !== -1 && lastObj > firstObj) {
      start = firstObj;
      end = lastObj + 1;
    }
    if (firstArr !== -1 && lastArr > firstArr) {
      if (start === -1 || (firstArr !== -1 && firstArr < start)) {
        start = firstArr;
        end = lastArr + 1;
      }
    }

    if (start !== -1 && end > start) {
      const sub = cleaned.substring(start, end);
      try {
        return JSON.parse(sub) as T;
      } catch {
        // Substring fallback parse failed, will throw original error below
      }
    }
    throw e;
  }
}

/**
 * Escapes the characters that carry meaning inside a SQL LIKE pattern.
 *
 * Finding M16: `.ilike('id', value)` means "equals, ignoring case" at every
 * call site in this app, but PostgREST passes `%` and `_` through as
 * wildcards. Rejecting them is not an option — `_` is legal in a real account
 * id (`Ares_Actual`) — so they are escaped instead.
 */
export function escapeLike(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}
