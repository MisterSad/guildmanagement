/**
 * src/modules/ocr/ocr.service.ts
 *
 * OCR roster/metric diffing and player-metric persistence, ported from
 * gm-utils.js. Pure helpers plus a couple of IO helpers (image compression,
 * metrics upsert, guild export).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { findBestMatchingMember, cleanPlayerPseudo, parseGeminiJson } from '../../core/utils/text';
import { getClient } from '../../core/api/supabase';
import { SUPABASE_URL } from '../../core/config/constants';

export { parseGeminiJson };

const OCR_VIDEO_CELL_DIFF_THRESHOLD = 0.08;

export interface UidStatus {
  valid: boolean;
  status: 'missing' | 'temp' | 'nan' | 'length' | 'valid';
  label: string;
  reason: string | null;
}

/** Evaluates whether a player UID is a valid in-game 6-10 digit identifier. */
export function getUidStatus(uid?: string | null): UidStatus {
  if (uid === null || uid === undefined || uid === '' || uid === '-') {
    return { valid: false, status: 'missing', label: 'Missing UID', reason: 'UID is not set' };
  }
  const clean = String(uid).trim();
  if (clean.length === 0 || clean === '-') {
    return { valid: false, status: 'missing', label: 'Missing UID', reason: 'UID is not set' };
  }
  if (/^TEMP[-_]/i.test(clean) || /^TMP[-_]/i.test(clean) || clean.toUpperCase() === 'TEMP') {
    return { valid: false, status: 'temp', label: 'Temporary UID', reason: 'Temporary placeholder UID generated during import' };
  }
  if (!/^[0-9]+$/.test(clean)) {
    return { valid: false, status: 'nan', label: 'Invalid Format', reason: 'UID must contain only digits (no letters or symbols)' };
  }
  if (clean.length < 6 || clean.length > 10) {
    return { valid: false, status: 'length', label: 'Invalid Length', reason: 'FGF game UID must be between 6 and 10 digits' };
  }
  return { valid: true, status: 'valid', label: 'Valid Game UID', reason: null };
}

export function isInvalidOrTempUid(uid?: string | null): boolean {
  return !getUidStatus(uid).valid;
}

export interface OcrDiffResult {
  existing: any[];
  new: any[];
  removed: any[];
  unknown: any[];
}

/** Categorises OCR players against the current roster (members or metric mode). */
export function categorizeOcrDiff(
  players: any[],
  roster: any[],
  guildTag: string | null,
  targetField: string,
  isMultiGuild: boolean,
  mode?: string
): OcrDiffResult {
  const opMode = (mode === 'metric') ? 'metric' : 'members';

  if (!players || !Array.isArray(players) || players.length === 0) {
    return { existing: [], new: [], removed: [], unknown: [] };
  }

  const members = Array.isArray(roster) ? roster : [];
  const field = targetField || 'overall_power';
  const isMulti = !!isMultiGuild;

  const existingList: any[] = [];
  const newList: any[] = [];
  const removedList: any[] = [];
  const unknownList: any[] = [];
  const seenMemberPseudos = new Set<string>();

  players.forEach((p, idx) => {
    if (!p || !p.pseudo || !String(p.pseudo).trim()) return;

    const matchRes = findBestMatchingMember(p.pseudo, members, guildTag);
    const member = matchRes ? matchRes.member : null;
    const matchType = matchRes ? matchRes.matchType : null;

    const cleanPseudo = cleanPlayerPseudo(p.pseudo, guildTag) || String(p.pseudo).trim();
    const effectivePseudo = member ? member.pseudo : cleanPseudo;

    if (member) {
      seenMemberPseudos.add(member.pseudo.trim().toLowerCase());
      const currentVal = parseInt((member as any)[field], 10) || 0;
      const pScore = p.score != null ? p.score : (p.overall_power || 0);

      let status = 'unchanged';
      if ((matchType === 'fuzzy' || matchType === 'normalized' || matchType === 'clean_tag') && p.pseudo !== member.pseudo) {
        status = 'reconciled';
      } else if (currentVal !== pScore) {
        status = 'update';
      }

      existingList.push({
        index: idx, ocrPlayer: p, member: member, matchType: matchType, matchScore: matchRes ? matchRes.score : 0,
        status: status, currentVal: currentVal, newVal: pScore, effectivePseudo: member.pseudo, uid: member.uid || ''
      });
    } else {
      const score = p.score != null ? p.score : (p.overall_power || 0);
      if (opMode === 'metric') {
        unknownList.push({ index: idx, ocrPlayer: p, status: 'not_in_roster', currentVal: 0, newVal: score, effectivePseudo: effectivePseudo, uid: p.uid || '' });
      } else {
        const newStatus = isMulti ? 'other_guild' : 'new';
        newList.push({ index: idx, ocrPlayer: p, status: newStatus, currentVal: 0, newVal: score, effectivePseudo: effectivePseudo, uid: p.uid || '' });
      }
    }
  });

  if (opMode === 'members' && members.length > 0) {
    members.forEach((m) => {
      if (!m || !m.pseudo) return;
      const pseudoKey = m.pseudo.trim().toLowerCase();
      if (!seenMemberPseudos.has(pseudoKey)) {
        removedList.push({
          member: m, pseudo: m.pseudo, uid: m.uid || '', role: m.role || 'R1',
          currentPower: parseInt(m.overall_power, 10) || 0, status: 'to_remove'
        });
      }
    });
  }

  return { existing: existingList, new: newList, removed: removedList, unknown: unknownList };
}

/** Projects the roster size before/after applying selected adds/removals. */
export function computeOcrRosterDelta(rosterCount: unknown, selectedNewCount: unknown, selectedRemovalCount: unknown): { before: number; after: number; added: number; removed: number } {
  const before = Math.max(0, parseInt(String(rosterCount), 10) || 0);
  const added = Math.max(0, parseInt(String(selectedNewCount), 10) || 0);
  const removed = Math.max(0, parseInt(String(selectedRemovalCount), 10) || 0);
  const after = Math.max(0, before + added - removed);
  return { before: before, after: after, added: added, removed: removed };
}

/** Upserts player metrics via gm_upsert_player_metrics (object or positional args). */
export async function upsertPlayerMetrics(arg1: any, arg2?: any, arg3?: any, arg4?: any): Promise<any> {
  let guild: string | undefined;
  let pseudo: string | undefined;
  let metrics: any;
  if (typeof arg1 === 'object' && arg1 !== null) {
    const p = arg1;
    guild = arg2 || p.guild;
    pseudo = p.pseudo;
    metrics = p;
  } else {
    guild = arg1;
    pseudo = arg2;
    metrics = (typeof arg3 === 'object' && arg3 !== null) ? arg3 : (arg4 || {});
  }
  if (!guild || !pseudo) return null;
  const w = (typeof window !== 'undefined' ? window : {}) as any;
  const supabase = (w.GM && w.GM.db) || w.supabaseClient;
  if (!supabase) return null;
  try {
    return await supabase.rpc('gm_upsert_player_metrics', {
      p_guild: guild,
      p_pseudo: pseudo,
      p_total_power: metrics.overall_power != null ? metrics.overall_power : null,
      p_tech_power: metrics.tech_power != null ? metrics.tech_power : null,
      p_champion_power: metrics.champion_power != null ? metrics.champion_power : null,
      p_crew_power: metrics.crew_power != null ? metrics.crew_power : null,
      p_flagship_power: metrics.flagship_power != null ? metrics.flagship_power : null,
      p_fleet_rating: metrics.fleet_rating != null ? metrics.fleet_rating : null,
      p_glory_score: metrics.glory_score != null ? metrics.glory_score : null
    });
  } catch (err) {
    console.warn('gm_upsert_player_metrics rpc error for ' + pseudo + ':', err);
    return null;
  }
}

/** Fraction (0..1) of grid cells whose luminance changed beyond the threshold. */
export function ocrGridDiffRatio(a?: number[] | null, b?: number[] | null): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > OCR_VIDEO_CELL_DIFF_THRESHOLD) changed++;
  }
  return changed / a.length;
}

/** Evenly downsamples an ordered list to at most maxCount items. */
export function ocrDownsampleEvenly<T>(items: T[], maxCount: number): T[] {
  if (!Array.isArray(items) || items.length <= maxCount) return items ? items.slice() : [];
  if (maxCount <= 1) return items.length ? [items[0]] : [];
  const result: T[] = [];
  const seen: Record<number, boolean> = {};
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.round(i * (items.length - 1) / (maxCount - 1));
    if (!seen[idx]) { seen[idx] = true; result.push(items[idx]); }
  }
  return result;
}

/** Downscales + JPEG-compresses an image to a data URL (falls back to raw). */
export function compressImageForUpload(fileOrBlob: Blob, maxDimension?: number, quality?: number): Promise<string> {
  const maxDim = maxDimension || 1280;
  const q = (typeof quality === 'number') ? quality : 0.82;

  return new Promise((resolve, reject) => {
    if (!fileOrBlob || typeof FileReader === 'undefined') {
      return reject(new Error('Invalid image file'));
    }
    const reader = new FileReader();
    reader.onload = (e: any) => {
      if (typeof Image === 'undefined' || typeof document === 'undefined') {
        return resolve(e.target.result);
      }
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
            else { w = Math.round((w * maxDim) / h); h = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(e.target.result);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', q));
        } catch (err) {
          resolve(e.target.result);
        }
      };
      img.onerror = () => { resolve(e.target.result); };
      img.src = e.target.result;
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(fileOrBlob);
  });
}

/** Downloads the caller's guild data as an .xlsx workbook (Edge Function). */
export async function exportGuildData(guild?: string): Promise<{ ok: boolean; error?: string; message?: string; filename?: string }> {
  const c = getClient();
  if (!c) return { ok: false, error: 'no_client' };
  let sessionRes: any;
  try { sessionRes = await c.auth.getSession(); } catch (_) { return { ok: false, error: 'no_session' }; }
  const session = sessionRes && sessionRes.data && sessionRes.data.session;
  if (!session || !session.access_token) return { ok: false, error: 'no_session' };

  let res: Response;
  try {
    res = await fetch(SUPABASE_URL + '/functions/v1/guild-data-export', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify(guild ? { guild: guild } : {})
    });
  } catch (err: any) {
    return { ok: false, error: 'network_error', message: err.message };
  }

  if (!res.ok) {
    let errBody: any = null;
    try { errBody = await res.json(); } catch (_) { /* ignore */ }
    return { ok: false, error: (errBody && errBody.error) || 'export_failed' };
  }

  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : 'guild_export.xlsx';

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { ok: true, filename: filename };
}
