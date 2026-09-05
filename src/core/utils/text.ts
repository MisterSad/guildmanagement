/**
 * src/core/utils/text.ts
 *
 * String manipulation, fuzzy matching, Levenshtein distance, number formatting,
 * and OCR JSON parsing utilities.
 * Extracted from gm-utils.js as part of Ticket 3.2 modularization.
 */

export const MAX_NUMERIC = 9999999999;

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
    const tagClean = guildTag.replace(/[\[\]]/g, '').trim();
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
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
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

  const clean1 = s1.replace(/\[[^\]]*\]|\([^\)]*\)/g, '').replace(/[^a-z0-9]/gi, '');
  const clean2 = s2.replace(/\[[^\]]*\]|\([^\)]*\)/g, '').replace(/[^a-z0-9]/gi, '');
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

  const targetClean = (cleanTarget || target).replace(/\[[^\]]*\]|\([^\)]*\)/g, '').replace(/[^a-z0-9]/gi, '');
  if (targetClean.length >= 3) {
    const normMatch = members.find((m) => {
      const mClean = (m.pseudo || '').trim().toLowerCase().replace(/\[[^\]]*\]|\([^\)]*\)/g, '').replace(/[^a-z0-9]/gi, '');
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
  const cleaned = String(jsonText).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
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
      } catch (e2) {
        // Substring fallback parse failed, will throw original error below
      }
    }
    throw e;
  }
}
