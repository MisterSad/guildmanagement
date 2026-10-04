/**
 * src/modules/app/ocr/ocr.controller.ts
 *
 * Sous-lot 6.7 (Strangler) — OCR modal lifecycle, dropdown/timezone collapsible,
 * video upload (ADR-021), file handling, the ocr-guild-members Edge call, and
 * the roster/event commit flow ported from app.js. Reuses the pure helpers in
 * src/modules/ocr/ocr.service.ts. All feedback via dialogs.service; removal
 * confirmation via dialogs.service showConfirm; extracted values escaped by the
 * renderer. Every collaborator is a typed import (phase M4c).
 */

import { adoptDialog, closeDialog } from '../../../components/ui/Dialog';
import { eventsViewLazy, armsRaceViewLazy, shadowfrontViewLazy } from '../lazy-views';
import { esc, byId } from '../admin/utils';
import { showToast, showConfirm } from '../dialogs/dialogs.service';
import { getClient } from '../../../core/api/supabase';
import { t } from '../../../core/i18n/i18n';
import { runInChunks } from '../../../core/utils/async';
import { getWeekStart } from '../../../core/utils/date';
import { validateUid } from '../../../core/utils/text';
import { cache } from '../../../core/cache/cache';
import { getGuildTag } from '../../../core/config/guild-config';
import { isRoleAllowedForBulk } from '../../members/members.service';
import { getGuildMembers } from '../members/members.store';
import { renderGuildMembers } from '../members/members.render';
import {
  ocrDownsampleEvenly,
  categorizeOcrDiff,
  parseOcrScore,
  compressImageForUpload,
  fuseOcrPlayers,
  recordEventAttendance,
  commitOcrRoster,
  invokeOcrVideo,
  invokeOcrImages,
  fetchEventSessionStatus,
  listShadowfrontAssignments,
  findBannedUids,
  uploadOcrVideo,
  removeOcrVideo,
  checkUidExistsGlobally,
  findPlayerByUid,
} from '../../ocr/ocr.service';
import { getActiveGuild } from '../../../core/auth/roles';
import { fetchGuildMembers } from '../members/members.controller';
import {
  OCR_METRICS_META,
  getCurrentOcrMetric,
  setCurrentOcrMetric,
  getOcrExtractedPlayers,
  setOcrExtractedPlayers,
  getOcrMeta,
  getOcrModel,
  getOcrScanDay,
  setOcrScanDay,
  setOcrVideoCoverage,
  getOcrVideoCoverage,
  type OcrVideoCoverage,
} from './ocr.meta';
import { renderOcrResults, renderOcrCoverage, toggleAllCheckboxes } from './ocr.render';
import { EventsService } from '../../events/events.service';

export { getOcrModel };

/** War prep metric commit target: event name + day container (0 = aggregate). */
interface WarOcrDayTarget {
  eventName: 'SvS' | 'GvG';
  day: number;
}

/**
 * Maps an SvS/GvG OCR metric to its daily-score container. All SvS/GvG score
 * commits flow through EventsService.upsertDailyScores (which invokes
 * gm_upsert_daily_scores) — never a direct event_participants.score_prep write.
 */
function resolveWarOcrDay(metric: string): WarOcrDayTarget | null {
  if (metric === 'svs_prep') return { eventName: 'SvS', day: 0 };
  if (metric === 'gvg_prep') return { eventName: 'GvG', day: 0 };
  if (metric === 'svs_day') return { eventName: 'SvS', day: getOcrScanDay() };
  if (metric === 'gvg_day') return { eventName: 'GvG', day: getOcrScanDay() };
  if (metric === 'svs_pvp') return { eventName: 'SvS', day: 6 };
  if (metric === 'gvg_pvp') return { eventName: 'GvG', day: 6 };
  return null;
}

function db(): any {
  return getClient();
}
function members(): any[] {
  return getGuildMembers();
}

// ── Modal lifecycle ──────────────────────────────────────────────────────────

export async function setOcrMetric(metric: string): Promise<void> {
  setCurrentOcrMetric(metric);
  const active = getCurrentOcrMetric();
  const meta = getOcrMeta(active);

  document.querySelectorAll('#ocr-metric-tabs .gm-seg-btn').forEach((btn) => {
    const m = btn.getAttribute('data-metric') || '';
    const isActive = m === active;
    btn.classList.toggle('active', isActive);
    (btn as HTMLElement).style.background = isActive
      ? OCR_METRICS_META[m]
        ? OCR_METRICS_META[m].color
        : 'var(--accent)'
      : 'transparent';
    // Dark text: every metric colour is light enough that white fails AA (M5).
    (btn as HTMLElement).style.color = isActive ? '#0b0f19' : 'var(--text-muted)';
  });

  const titleEl = byId('ocr-modal-title');
  const subEl = byId('ocr-modal-subtitle');
  const dropTitle = byId('ocr-dropzone-title');
  const dropDesc = byId('ocr-dropzone-desc');
  const metricHeader = byId('ocr-metric-header');
  const rankHeader = byId('ocr-rank-header');
  if (titleEl) titleEl.textContent = meta.title;
  if (subEl) subEl.textContent = meta.subtitle;
  if (dropTitle) dropTitle.textContent = meta.dropTitle;
  if (dropDesc) dropDesc.textContent = meta.dropDesc;
  if (metricHeader) metricHeader.textContent = meta.header;
  if (rankHeader) rankHeader.style.display = active === 'members' ? '' : 'none';

  const scopeBadge = byId('ocr-scope-badge');
  const scopeDesc = byId('ocr-scope-desc');
  const tagInputGroup = byId('ocr-tag-input-group');
  const tagInput = byId<HTMLInputElement>('ocr-guild-tag-input');

  let configuredTag = '';
  configuredTag = await getGuildTag();
  if (tagInput && (!tagInput.value || tagInput.dataset.autoFilled === 'true')) {
    tagInput.value = configuredTag || '';
    tagInput.dataset.autoFilled = 'true';
  }

  if (meta.isMultiGuild) {
    if (scopeBadge) {
      scopeBadge.innerHTML = '<i class="ph ph-globe"></i> Leaderboard (Tag Filtered)';
      scopeBadge.style.background = 'rgba(234,179,8,0.18)';
      scopeBadge.style.color = '#facc15';
    }
    if (scopeDesc)
      scopeDesc.textContent =
        'Screenshots contain multi-guild players. Targeting members with tag ' +
        (tagInput && tagInput.value ? tagInput.value : configuredTag) +
        '.';
    if (tagInputGroup) tagInputGroup.style.display = 'flex';
  } else if (meta.isEvent) {
    if (scopeBadge) {
      scopeBadge.innerHTML = '<i class="' + (meta.icon || 'ph-sword') + '"></i> Event Session Scan';
      scopeBadge.style.background = 'rgba(99,102,241,0.18)';
      scopeBadge.style.color = meta.color || 'var(--accent-text)';
    }
    if (scopeDesc)
      scopeDesc.textContent = meta.subtitle || 'Screenshots will update event participants for active session.';
    if (tagInputGroup) tagInputGroup.style.display = 'none';
  } else {
    if (scopeBadge) {
      scopeBadge.innerHTML = '<i class="ph ph-shield-check"></i> Intra-Guild Scan';
      scopeBadge.style.background = 'rgba(99,102,241,0.18)';
      scopeBadge.style.color = 'var(--accent-text)';
    }
    if (scopeDesc) scopeDesc.textContent = 'Screenshots contain exclusively your guild members (full roster scan).';
    if (tagInputGroup) tagInputGroup.style.display = 'none';
  }

  // Per-day war metrics (svs_day / gvg_day): show the day selector and
  // highlight the current target day. The selection feeds metadata.scanDay.
  const isDayMetric = active === 'svs_day' || active === 'gvg_day';
  const daySelector = byId('ocr-day-selector');
  if (daySelector) daySelector.style.display = isDayMetric ? 'flex' : 'none';
  if (isDayMetric) {
    document.querySelectorAll('#ocr-day-buttons .gm-seg-btn').forEach((btn) => {
      const d = parseInt(btn.getAttribute('data-ocr-day') || '', 10);
      btn.classList.toggle('gm-active', Number.isInteger(d) && d === getOcrScanDay());
    });
  }
}

export function resetOcrModalState(): void {
  setOcrExtractedPlayers([]);
  setOcrVideoCoverage(null);
  renderOcrCoverage(null);
  const dropzone = byId('ocr-dropzone');
  const loading = byId('ocr-loading');
  const resultsContainer = byId('ocr-results-container');
  const btnCommit = byId('ocr-commit-btn');
  const fileInput = byId<HTMLInputElement>('ocr-file-input');
  const filterInput = byId<HTMLInputElement>('ocr-filter-search');
  if (dropzone) dropzone.style.display = 'block';
  if (loading) loading.style.display = 'none';
  if (resultsContainer) resultsContainer.style.display = 'none';
  if (btnCommit) btnCommit.style.display = 'none';
  if (fileInput) fileInput.value = '';
  if (filterInput) filterInput.value = '';
}

/** Releases the OCR modal's focus trap; set while the modal is open. */
let releaseOcrDialog: (() => void) | null = null;

export async function openOcrModal(metric?: string): Promise<void> {
  initOcrGeminiModule();
  await setOcrMetric(metric || 'power');
  const modal = byId('ocr-modal-overlay');
  if (modal) {
    modal.style.display = 'flex';
    modal.classList.add('visible');
    resetOcrModalState();
    // The modal lives in index.html and is shown, not created: adopt it on
    // every open, release it on close (M5).
    if (!releaseOcrDialog)
      releaseOcrDialog = adoptDialog(modal, { labelledBy: 'ocr-modal-title', onEscape: closeOcrModal });
  }
}

export function closeOcrModal(): void {
  // A confirmation opened over the modal goes first: it is on top of the stack.
  const confirmOverlay = typeof document !== 'undefined' ? document.getElementById('confirm-overlay') : null;
  if (confirmOverlay) {
    // closeDialog, not remove(): it releases the focus trap and the stack entry.
    closeDialog(confirmOverlay);
  }
  const modal = byId('ocr-modal-overlay');
  if (modal) {
    modal.classList.remove('visible');
    modal.style.display = 'none';
  }
  if (releaseOcrDialog) {
    releaseOcrDialog();
    releaseOcrDialog = null;
  }
}

// ── Dropdown + timezone collapsible ──────────────────────────────────────────

export function initOcrDropdown(): any {
  const trigger = byId('ocr-dropdown-trigger');
  const menu = byId('ocr-dropdown-menu');
  const container = byId('ocr-scanners-dropdown') || (trigger ? trigger.parentElement : null);
  if (!trigger || !menu) return null;
  if (trigger.dataset.dropdownInitialized === 'true') return null;
  trigger.dataset.dropdownInitialized = 'true';

  const closeMenu = (): void => {
    menu.style.display = 'none';
    menu.classList.remove('show');
    trigger.setAttribute('aria-expanded', 'false');
  };
  const openMenu = (): void => {
    menu.style.display = 'flex';
    menu.classList.add('show');
    trigger.setAttribute('aria-expanded', 'true');
  };
  const isOpen = (): boolean => menu.classList.contains('show') || menu.style.display === 'flex';
  const toggleMenu = (): void => {
    if (isOpen()) closeMenu();
    else openMenu();
  };

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMenu();
  });
  menu.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest('.btn-ocr-trigger')) closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (container && !container.contains(e.target as Node)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') closeMenu();
  });

  return { open: openMenu, close: closeMenu, toggle: toggleMenu, isOpen };
}

export function initTimezoneCollapsible(): any {
  const toggle = byId('admin-timezone-toggle');
  const body = byId('admin-timezone-body');
  const label = byId('admin-timezone-toggle-label');
  if (!toggle || !body) return null;
  if (toggle.dataset.collapsibleBound === 'true') return null;
  toggle.dataset.collapsibleBound = 'true';

  const update = (expanded: boolean): void => {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    body.style.display = expanded ? 'block' : 'none';
    if (label) {
      const key = expanded ? 'timezone_collapse' : 'timezone_expand';
      const fallback = expanded ? 'Collapse' : 'Expand';
      label.textContent = t(key) || fallback;
      label.setAttribute('data-i18n', key);
    }
  };

  toggle.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest && target.closest('.gm-help-btn')) return;
    update(toggle.getAttribute('aria-expanded') !== 'true');
  });
  toggle.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' || ke.key === ' ' || ke.keyCode === 13 || ke.keyCode === 32) {
      const target = e.target as HTMLElement | null;
      if (target && target.closest && target.closest('.gm-help-btn')) return;
      e.preventDefault();
      toggle.click();
    }
  });

  return {
    expand: () => update(true),
    collapse: () => update(false),
    isExpanded: () => toggle.getAttribute('aria-expanded') === 'true',
  };
}

let ocrModuleInitialized = false;

export function initOcrGeminiModule(): void {
  initOcrDropdown();
  if (ocrModuleInitialized) return;
  ocrModuleInitialized = true;

  const closeBtn = byId('ocr-modal-close');
  const cancelBtn = byId('ocr-modal-cancel');
  const fileInput = byId<HTMLInputElement>('ocr-file-input');
  const dropzone = byId('ocr-dropzone');
  const btnReset = byId('ocr-reset-btn');
  const btnSelectAll = byId('ocr-select-all-btn');
  const cbToggleAll = byId<HTMLInputElement>('ocr-toggle-all-cb');
  const btnCommit = byId('ocr-commit-btn');

  const metricTabs = byId('ocr-metric-tabs');
  if (metricTabs)
    metricTabs.querySelectorAll('.gm-seg-btn').forEach((btn) =>
      btn.addEventListener('click', () => {
        void setOcrMetric(btn.getAttribute('data-metric') || 'members');
      })
    );

  const dayButtons = document.querySelectorAll('#ocr-day-buttons .gm-seg-btn');
  if (dayButtons.length > 0) {
    dayButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = parseInt(btn.getAttribute('data-ocr-day') || '1', 10);
        setOcrScanDay(d);
        document.querySelectorAll('#ocr-day-buttons .gm-seg-btn').forEach((b) => {
          const bd = parseInt(b.getAttribute('data-ocr-day') || '', 10);
          b.classList.toggle('gm-active', Number.isInteger(bd) && bd === d);
        });
        const meta = getOcrMeta();
        const scopeDesc = byId('ocr-scope-desc');
        if (meta && meta.isEvent && scopeDesc) {
          scopeDesc.textContent =
            'Day ' + d + ' screenshots — scores are imported into the Day ' + d + ' column of the preparation grid.';
        }
      });
    });
  }

  const tagInput = byId<HTMLInputElement>('ocr-guild-tag-input');
  if (tagInput) {
    tagInput.addEventListener('input', () => {
      tagInput.dataset.autoFilled = 'false';
      const meta = OCR_METRICS_META[getCurrentOcrMetric()];
      const scopeDesc = byId('ocr-scope-desc');
      if (meta && meta.isMultiGuild && scopeDesc)
        scopeDesc.textContent =
          'Screenshots contain multi-guild players. Targeting members with tag ' + (tagInput.value || '[TAG]') + '.';
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', closeOcrModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeOcrModal);
  const overlay = byId('ocr-modal-overlay');
  if (overlay)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeOcrModal();
    });

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '#818cf8';
      dropzone.style.background = 'rgba(99, 102, 241, 0.08)';
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.style.borderColor = 'rgba(99, 102, 241, 0.4)';
      dropzone.style.background = 'rgba(99, 102, 241, 0.03)';
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'rgba(99, 102, 241, 0.4)';
      dropzone.style.background = 'rgba(99, 102, 241, 0.03)';
      const files = Array.from((e as DragEvent).dataTransfer?.files || []);
      if (files.length > 0) void handleOcrFiles(files);
    });
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      if (files.length > 0) void handleOcrFiles(files);
    });
  }

  if (btnReset) btnReset.addEventListener('click', resetOcrModalState);
  if (btnSelectAll && cbToggleAll)
    btnSelectAll.addEventListener('click', () => {
      cbToggleAll.checked = !cbToggleAll.checked;
      toggleAllCheckboxes(cbToggleAll.checked);
    });
  if (cbToggleAll) cbToggleAll.addEventListener('change', () => toggleAllCheckboxes(cbToggleAll.checked));
  if (btnCommit)
    btnCommit.addEventListener('click', () => {
      void commitOcrUpdates();
    });
}

// ── Video → Gemini (ADR-021) ─────────────────────────────────────────────────
//
// The recording is no longer cut into frames here. Which frames the browser kept
// decided which players were found, and on some recordings that was 3 or 4 out
// of 40. The file goes to a private, per-guild staging bucket, and
// ocr-guild-members hands it to Gemini whole, checks the rank positions it read
// for gaps, and re-reads the gaps once.

/** Mirrors the bucket (migration 20261001194004) and the Edge Function. */
const OCR_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
const OCR_VIDEO_MAX_DURATION_SEC = 300;
const OCR_VIDEO_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

/**
 * Reads only the metadata, to refuse an over-long recording before uploading
 * it. Resolves null when this browser cannot decode the file (HEVC on some
 * desktops): Gemini can still read it, and the server measures the duration
 * itself either way.
 */
function readVideoDuration(file: Blob): Promise<number | null> {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (d: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(d);
    };
    const timer = setTimeout(() => finish(null), 5000);
    video.preload = 'metadata';
    video.muted = true;
    video.addEventListener('loadedmetadata', () => finish(isFinite(video.duration) ? video.duration : null));
    video.addEventListener('error', () => finish(null));
    video.src = url;
  });
}

export async function callGeminiOcrVideoApi(
  file: Blob,
  metricType: string,
  guildTag: string,
  rankHint: string | null,
  updateStatusCallback?: (s: string) => void
): Promise<{ players: any[]; endingRank: string | null; coverage: OcrVideoCoverage | null }> {
  const client = db();
  if (!client || !client.functions || !client.storage)
    throw new Error('OCR service unavailable. Please sign in and try again.');

  const mimeType = String((file as File).type || '').toLowerCase();
  const ext = OCR_VIDEO_EXTENSIONS[mimeType];
  if (!ext) throw new Error('video_unsupported_type');
  if (file.size > OCR_VIDEO_MAX_BYTES) throw new Error('video_too_large');
  const duration = await readVideoDuration(file);
  if (duration !== null && duration > OCR_VIDEO_MAX_DURATION_SEC) throw new Error('video_too_long');

  // An unresolved tenant fails visibly; it never falls back to a guild.
  const guild = getActiveGuild();
  if (!guild) throw new Error('no_active_guild');
  const path = guild + '/' + crypto.randomUUID() + '.' + ext;

  if (updateStatusCallback) updateStatusCallback('Uploading the video…');
  const up = await uploadOcrVideo(client, path, file, mimeType);
  if (up && up.error) {
    console.error('OCR video upload failed:', up.error);
    throw new Error('video_upload_failed');
  }

  if (updateStatusCallback) updateStatusCallback('Gemini is reading the whole video — this takes up to a minute…');
  let metadata: { scanDay: number } | undefined;
  if (metricType === 'svs_day' || metricType === 'gvg_day') metadata = { scanDay: getOcrScanDay() };
  let res: any;
  try {
    res = await invokeOcrVideo(client, path, mimeType, metricType, guildTag, rankHint, metadata);
  } finally {
    // The function deletes the object itself; this covers a call that never
    // reached it. Removing an object that is already gone is a no-op.
    removeOcrVideo(client, path).catch(() => {});
  }

  if (res && res.data && res.data.ok && Array.isArray(res.data.players)) {
    const players = res.data.players.map((p: any) => ({
      ...p,
      score: parseOcrScore(p.score, p.raw_score),
      overall_power: parseOcrScore(p.overall_power != null ? p.overall_power : p.score, p.raw_score),
    }));
    return { players, endingRank: res.data.endingRank || null, coverage: res.data.coverage || null };
  }
  const errMsg =
    (res && res.data && res.data.error) || (res && res.error && res.error.message) || 'ocr_processing_failed';
  throw new Error(errMsg);
}

// ── Files → OCR ──────────────────────────────────────────────────────────────

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
}

export async function handleOcrFiles(files: File[] | Blob[]): Promise<void> {
  const dropzone = byId('ocr-dropzone');
  const loading = byId('ocr-loading');
  const resultsContainer = byId('ocr-results-container');
  const loadingH4 = loading ? loading.querySelector('h4') : null;
  const loadingP = loading ? loading.querySelector('p') : null;

  let imageFiles: Blob[] = (files as File[]).filter((f: any) => String(f.type).indexOf('image/') === 0);
  const videoFiles: Blob[] = (files as File[]).filter((f: any) => String(f.type).indexOf('video/') === 0);
  if (imageFiles.length === 0 && videoFiles.length === 0) {
    showToast('Please select a valid image (PNG, JPG, WEBP) or video (MP4, MOV) file.', 'error');
    return;
  }

  if (dropzone) dropzone.style.display = 'none';
  if (loading) loading.style.display = 'block';
  if (resultsContainer) resultsContainer.style.display = 'none';

  // Safety ceiling, not a budget: ocrDownsampleEvenly drops screenshots blindly,
  // and every one it drops is a screenful of players that never reaches the OCR.
  // Images are compressed one batch at a time below, so a large set costs
  // requests and time, never a decimated roster.
  const MAX_OCR_IMAGES = 500;
  if (imageFiles.length > MAX_OCR_IMAGES) {
    showToast(
      'That is ' +
        imageFiles.length +
        ' images — scanning the first ' +
        MAX_OCR_IMAGES +
        ' evenly spread across the set. Split them in two to scan all of them.',
      'warning'
    );
    imageFiles = ocrDownsampleEvenly(imageFiles, MAX_OCR_IMAGES);
  }

  const metric = getCurrentOcrMetric();
  const meta = getOcrMeta(metric);
  const tagInput = byId<HTMLInputElement>('ocr-guild-tag-input');
  let activeGuildTag = '';
  if (tagInput && tagInput.value.trim()) activeGuildTag = tagInput.value.trim();
  else activeGuildTag = await getGuildTag();

  // Lazy roster prefetch: if the in-memory store is empty (user opened OCR
  // from an event/GvG/SvS tab without first visiting the Members tab), we
  // silently fetch the roster so that fuseOcrPlayers and renderOcrResults
  // can match member pseudos correctly against guild members.
  // This is a no-op when the roster is already loaded (normal flow).
  if (members().length === 0) {
    try {
      if (loadingP) loadingP.textContent = 'Loading guild roster for member matching…';
      await fetchGuildMembers();
    } catch (_) {
      /* best-effort — OCR proceeds even without roster */
    }
  }

  let allPlayers: any[] = [];
  setOcrVideoCoverage(null);
  try {
    // Videos first, one call each: the server reads the whole recording.
    const videoErrors: string[] = [];
    let videoCoverage: OcrVideoCoverage | null = null;
    for (let v = 0; v < videoFiles.length; v++) {
      if (loadingH4)
        loadingH4.textContent =
          'Reading video' +
          (videoFiles.length > 1 ? ' ' + (v + 1) + ' of ' + videoFiles.length : '') +
          ' with AI OCR (' +
          meta.header +
          ')...';
      try {
        const res = await callGeminiOcrVideoApi(videoFiles[v], metric, activeGuildTag, null, (statusMsg: string) => {
          if (loadingP) loadingP.textContent = statusMsg;
        });
        allPlayers = allPlayers.concat(res.players);
        videoCoverage = res.coverage;
      } catch (videoErr: any) {
        console.error('OCR video ' + (v + 1) + ' of ' + videoFiles.length + ' failed:', videoErr);
        videoErrors.push(videoErr && videoErr.message ? videoErr.message : 'unknown_error');
      }
    }
    // A coverage figure describes one recording. With several videos, or with
    // screenshots fused in, it no longer describes the table below.
    if (videoFiles.length === 1 && imageFiles.length === 0) setOcrVideoCoverage(videoCoverage);
    if (videoErrors.length > 0 && imageFiles.length === 0 && allPlayers.length === 0) {
      throw new Error(ocrBatchErrorMessage(videoErrors[0]));
    }
    if (videoErrors.length > 0) {
      showToast(
        videoErrors.length +
          ' of ' +
          videoFiles.length +
          ' videos could not be read: ' +
          ocrBatchErrorMessage(videoErrors[0]),
        'warning'
      );
    }
    if (imageFiles.length > 0 && loadingH4)
      loadingH4.textContent = 'Analyzing screenshots with AI OCR (' + meta.header + ')...';

    // The ~900-token system instruction is re-sent with every call, and at two
    // images per call it cost MORE than the images themselves: measured on a
    // 64-frame scan, 34,272 tokens of repeated prompt against 16,512 of image.
    // Four amortises it across twice the images and stays a margin below the
    // Edge Function's hard limit of five. The previous value of 2 was described
    // in this comment as calibrated for accuracy, but nothing in the repository
    // measures that, so the margin to 5 is deliberate.
    const chunkSize = 4;
    const chunks: Blob[][] = [];
    for (let c = 0; c < imageFiles.length; c += chunkSize) chunks.push(imageFiles.slice(c, c + chunkSize));

    // Compression is per batch, immediately before that batch is sent, rather
    // than for every image up front. The old Promise.all held one base64 data
    // URL per image alive at the same time; at the frame counts a video now
    // produces that is tens of megabytes of strings on a phone, and lifting the
    // image cap without this would only trade missing players for an OOM.
    const prepareChunk = async (blobs: Blob[]): Promise<any[]> =>
      Promise.all(
        blobs.map(async (file) => {
          try {
            const b64 = await compressImageForUpload(file, 1600, 0.82);
            return { mimeType: 'image/jpeg', base64Data: b64 };
          } catch (_) {
            const b64 = await fileToBase64(file);
            return { mimeType: (file as File).type || 'image/png', base64Data: b64 };
          }
        })
      );

    // A batch that fails takes its two screens of players with it, and the
    // failures that matter here are transient: a Gemini rate limit, a cold
    // start, a truncated candidate. One retry with a backoff recovers those
    // without making a real failure take four times as long to report.
    // Deliberately narrow. `json_parse_failed` is not here: the Edge Function
    // already retries a truncated candidate against the next model, so retrying
    // it again from the client only spends the images' tokens a second time to
    // reach the same answer.
    const RETRYABLE = ['ocr_processing_failed', 'too_many_attempts'];
    const callChunkWithRetry = async (
      blobs: Blob[],
      rank: string | null,
      onStatus?: (s: string) => void
    ): Promise<{ players: any[]; endingRank: string | null }> => {
      const items = await prepareChunk(blobs);
      try {
        return await callGeminiOcrBatchApi(items, metric, activeGuildTag, rank, onStatus);
      } catch (firstErr: any) {
        const code = firstErr && firstErr.message ? String(firstErr.message) : '';
        if (!RETRYABLE.includes(code)) throw firstErr;
        await new Promise((r) => setTimeout(r, 1200));
        try {
          return await callGeminiOcrBatchApi(items, metric, activeGuildTag, rank, onStatus);
        } catch (_retryErr) {
          // The first failure is the one that says something useful about why
          // the scan failed; the retry's is just the same wall hit twice.
          throw firstErr;
        }
      }
    };

    const isMembersMode = metric === 'members';

    // One batch failing used to reject the whole run: `Promise.all(workers)`
    // rejected, the catch below fired, and every batch that HAD succeeded was
    // discarded. That is why a video failed where screenshots did not -- not
    // because video frames are harder, but because a video makes 18 batches
    // where a screenshot makes one, and any single failure took all of them
    // down with it. Failures are now counted, not thrown.
    const batchErrors: string[] = [];

    if (isMembersMode) {
      // In Members mode, rank headers ("Executive Manager", "Rank 3 Members", etc.)
      // flow sequentially across batches via carryRank.
      let carryRank: string | null = null;
      for (let b = 0; b < chunks.length; b++) {
        if (loadingP) {
          loadingP.textContent =
            'Processing screenshots batch ' +
            (b + 1) +
            ' of ' +
            chunks.length +
            ' (' +
            imageFiles.length +
            ' total images)...';
        }
        try {
          const batchResult = await callChunkWithRetry(chunks[b], carryRank, (statusMsg: string) => {
            if (loadingP) loadingP.textContent = statusMsg;
          });
          allPlayers = allPlayers.concat(batchResult.players);
          if (batchResult.endingRank) carryRank = batchResult.endingRank;
        } catch (batchErr: any) {
          // The rank carried from the previous batch is kept: a failed batch
          // tells us nothing about the rank headers, and resetting it would
          // mis-assign every member after it.
          console.error('OCR batch ' + (b + 1) + ' of ' + chunks.length + ' failed:', batchErr);
          batchErrors.push(batchErr && batchErr.message ? batchErr.message : 'unknown_error');
        }
        if (b < chunks.length - 1) await new Promise((r) => setTimeout(r, 250));
      }
    } else {
      // Metric & Event modes: process with a concurrency pool of 3 parallel requests
      const concurrency = 3;
      let completedChunks = 0;
      const batchResults = new Array(chunks.length);
      let nextChunkIdx = 0;

      const worker = async (): Promise<void> => {
        while (nextChunkIdx < chunks.length) {
          const idx = nextChunkIdx++;
          try {
            batchResults[idx] = await callChunkWithRetry(chunks[idx], null);
          } catch (batchErr: any) {
            console.error('OCR batch ' + (idx + 1) + ' of ' + chunks.length + ' failed:', batchErr);
            batchErrors.push(batchErr && batchErr.message ? batchErr.message : 'unknown_error');
          }
          completedChunks++;
          if (loadingP) {
            loadingP.textContent =
              'Processed batch ' +
              completedChunks +
              ' of ' +
              chunks.length +
              ' (' +
              imageFiles.length +
              ' total images)...';
          }
        }
      };

      const workers = new Array(Math.min(concurrency, chunks.length)).fill(0).map(() => worker());
      await Promise.all(workers);

      for (const res of batchResults) {
        if (res && Array.isArray(res.players)) {
          allPlayers = allPlayers.concat(res.players);
        }
      }
    }

    // Every batch failed: there is nothing to show, so say so the way a total
    // failure should be said, with the reason the server actually gave.
    if (batchErrors.length > 0 && allPlayers.length === 0) {
      throw new Error(ocrBatchErrorMessage(batchErrors[0]));
    }
    if (batchErrors.length > 0) {
      // Partial is worth keeping -- the results table already flags a partial
      // scan and leaves missing members unchecked -- but it must not be silent.
      showToast(
        batchErrors.length +
          ' of ' +
          chunks.length +
          ' batches failed. The table below is incomplete: review it before committing, or re-run the scan.',
        'warning'
      );
    }

    // Multi-frame deduplication and fusion
    const roster = members();
    const fused = fuseOcrPlayers(allPlayers, roster, activeGuildTag);

    setOcrExtractedPlayers(fused);
    renderOcrResults(getOcrExtractedPlayers());
    renderOcrCoverage(getOcrVideoCoverage());
  } catch (err: any) {
    console.error('OCR processing error:', err);
    showToast(err.message || 'OCR Analysis failed', 'error');
    if (loading) loading.style.display = 'none';
    if (dropzone) dropzone.style.display = 'block';
  }
}

/** Turns the Edge Function's error codes into something a guild admin can act on. */
function ocrBatchErrorMessage(code: string): string {
  switch (code) {
    case 'json_parse_failed':
      return 'The AI returned an incomplete reading. Try again, or scan fewer screens at once.';
    case 'ocr_processing_failed':
      return 'The AI OCR engine could not read these images. Try again in a moment.';
    case 'payload_too_large':
      return 'Those images are too large. Try a shorter recording or fewer screenshots.';
    case 'too_many_attempts':
      return 'Too many scans in a short time. Wait a minute and try again.';
    case 'video_unsupported_type':
      return 'This video format is not supported. Record as MP4 (or MOV / WebM), or use screenshots.';
    case 'video_too_large':
      return 'That video is over 64 MB. Record a shorter scroll, or lower the recording resolution.';
    case 'video_too_long':
      return 'That video is over 5 minutes. Trim it to the part where the list scrolls.';
    case 'video_upload_failed':
      return 'The video could not be uploaded. Check your connection and try again.';
    case 'video_not_found':
      return 'The uploaded video could not be read back. Try again.';
    case 'video_processing_failed':
      return 'The AI could not process that video. Re-export it as H.264 MP4, or use screenshots.';
    case 'no_active_guild':
      return 'No guild is selected. Reload the page and pick your guild before scanning.';
    default:
      return code || 'OCR analysis failed. Please try again.';
  }
}

export async function callGeminiOcrBatchApi(
  batchImageItems: any[],
  metricType: string,
  guildTag: string,
  rankHint: string | null | ((s: string) => void),
  updateStatusCallback?: (s: string) => void
): Promise<{ players: any[]; endingRank: string | null }> {
  if (typeof guildTag === 'function') {
    updateStatusCallback = guildTag as any;
    rankHint = null;
    guildTag = '';
  } else if (typeof rankHint === 'function') {
    updateStatusCallback = rankHint as any;
    rankHint = null;
  }
  metricType = metricType || 'power';
  guildTag = guildTag || '';
  const client = db();
  if (!client || !client.functions) throw new Error('OCR service unavailable. Please sign in and try again.');

  if (updateStatusCallback)
    updateStatusCallback(
      'Analyzing with AI OCR (' + metricType.toUpperCase() + (guildTag ? ' ' + guildTag : '') + ')...'
    );
  // Per-day war metrics attach the validated scan-day target to the metadata
  // object (the Edge Function re-validates it through the Zod scanDay enum).
  let metadata: { scanDay: number } | undefined;
  if (metricType === 'svs_day' || metricType === 'gvg_day') metadata = { scanDay: getOcrScanDay() };
  const res = await invokeOcrImages(client, batchImageItems, metricType, guildTag, rankHint, metadata);
  if (res.data && res.data.ok && Array.isArray(res.data.players)) {
    const sanitized = res.data.players.map((p: any) => {
      const parsedScore = parseOcrScore(p.score, p.raw_score);
      return {
        ...p,
        score: parsedScore,
        overall_power: parseOcrScore(p.overall_power != null ? p.overall_power : p.score, p.raw_score),
      };
    });
    return { players: sanitized, endingRank: res.data.endingRank || null };
  }
  const errMsg =
    (res.data && res.data.error) || (res.error && res.error.message) || 'OCR analysis failed. Please try again.';
  throw new Error(errMsg);
}

// ── Commit ───────────────────────────────────────────────────────────────────

export async function commitOcrUpdates(): Promise<void> {
  const tbody = byId('ocr-results-tbody');
  const tbodyNew = byId('ocr-results-tbody-new');
  const tbodyRemoved = byId('ocr-results-tbody-removed');
  const btnCommit = byId<HTMLButtonElement>('ocr-commit-btn');
  if (!btnCommit) return;

  const metric = getCurrentOcrMetric();
  const meta = getOcrMeta(metric);
  const targetField = meta.field;
  const extracted = getOcrExtractedPlayers();

  if (meta.isEvent) {
    if (!tbody) return;
    const selectedIndices: number[] = [];
    tbody
      .querySelectorAll('.ocr-row-cb:checked')
      .forEach((cb) => selectedIndices.push(parseInt(cb.getAttribute('data-index') || '0', 10)));
    if (selectedIndices.length === 0) {
      showToast('No players selected.', 'error');
      return;
    }
    const selectedPlayers = selectedIndices.map((idx) => extracted[idx]).filter(Boolean);
    btnCommit.disabled = true;
    const span = btnCommit.querySelector('span');
    if (span) span.textContent = 'Validating & Saving...';

    try {
      const client = db();
      // Unresolved tenant passes through as before; the RPCs refuse it (H2).
      const currentG = getActiveGuild() as string;
      if (meta.eventType === 'shadowfront') {
        const sqName = meta.squad === 'squad1' ? 'Shadowfront Squad 1' : 'Shadowfront Squad 2';
        const sqRes = await fetchEventSessionStatus(client, currentG, sqName);
        if (!sqRes.data || !sqRes.data.is_active || !sqRes.data.session_id) {
          showToast(
            'Please start the ' +
              (meta.squad === 'squad1' ? 'Squad 1' : 'Squad 2') +
              ' session in Events before applying OCR updates.',
            'error'
          );
          return;
        }
        const activeSid = sqRes.data.session_id;
        const assignRes = await listShadowfrontAssignments(client, currentG, activeSid);
        const assignMap: Record<string, string> = {};
        (assignRes.data || []).forEach((a: any) => {
          assignMap[String(a.pseudo).toLowerCase()] = a.role;
        });
        // One transaction for the whole read (M4a): each player's row is
        // updated or created, a reserve marked as such. Per-row failures used
        // to be swallowed.
        await recordEventAttendance(
          'Shadowfront',
          activeSid,
          getWeekStart(sqRes.data.start_at || new Date()),
          selectedPlayers.map((sp: any) => ({
            pseudo: sp.pseudo,
            sub_present: assignMap[String(sp.pseudo).toLowerCase()] === 'reserve',
          }))
        );
        // Phase 7: a direct call. The `window` probe silently skipped the
        // refresh whenever the namespace or method name drifted, leaving the
        // Shadowfront tab showing pre-OCR data with no error.
        await shadowfrontViewLazy.peek()?.load();
      } else if (meta.eventType === 'armsrace') {
        const arEvName = meta.stage === 'stageA' ? 'ARMS RACE STAGE A' : 'ARMS RACE STAGE B';
        const arRes = await fetchEventSessionStatus(client, currentG, arEvName);
        if (!arRes.data || !arRes.data.is_active || !arRes.data.session_id) {
          showToast(
            'Please start Arms Race ' +
              (meta.stage === 'stageA' ? 'Stage A' : 'Stage B') +
              ' session in Events before applying OCR updates.',
            'error'
          );
          return;
        }
        const arSid = arRes.data.session_id;
        await recordEventAttendance(
          arEvName,
          arSid,
          getWeekStart(arRes.data.start_at || new Date()),
          selectedPlayers.map((sp: any) => ({ pseudo: sp.pseudo }))
        );
        await armsRaceViewLazy.peek()?.load();
      } else {
        const evName = meta.eventKey;
        // `eventKey` is optional on the metric metadata. Without this guard an
        // unconfigured metric queried `event_name = undefined`, fell into the
        // branch below and told the user to "start the undefined session in
        // Events". Typing the call to loadEvent() is what surfaced it.
        if (!evName) {
          showToast('This OCR metric has no event configured.', 'error');
          return;
        }
        const evRes = await fetchEventSessionStatus(client, currentG, evName);
        if (!evRes.data || !evRes.data.is_active || !evRes.data.session_id) {
          showToast('Please start the ' + evName + ' session in Events before applying OCR updates.', 'error');
          return;
        }
        const evSid = evRes.data.session_id;
        const warDay = resolveWarOcrDay(metric);
        if (warDay) {
          // SvS/GvG commits ALWAYS flow through gm_upsert_daily_scores (via
          // EventsService.upsertDailyScores): day 0 for the aggregate totals,
          // scanDay for the per-day metrics, day 6 for PvP. Direct
          // event_participants.score_prep writes are forbidden here — the RPC
          // converges the grid (zero double-counting) and derives the cache.
          const rows = selectedPlayers.map((sp: any) => ({
            pseudo: sp.pseudo,
            day: warDay.day,
            score: sp.score != null ? sp.score : 0,
          }));
          // gm_upsert_daily_scores caps a batch at 200 rows — flush in chunks.
          for (let offset = 0; offset < rows.length; offset += 100) {
            const chunk = rows.slice(offset, offset + 100);
            const batchRes = await EventsService.upsertDailyScores(currentG, warDay.eventName, evSid, chunk);
            if (!batchRes.ok) throw new Error(batchRes.error || 'rpc_failed');
          }
        } else if (metric === 'dtr') {
          // A Trade Route read with no score is an appointee.
          await recordEventAttendance(
            evName,
            evSid,
            getWeekStart(evRes.data.start_at || new Date()),
            selectedPlayers.map((sp: any) => ({
              pseudo: sp.pseudo,
              appointed: !((sp.score != null ? sp.score : 0) > 0),
            }))
          );
        }
        await eventsViewLazy.peek()?.loadEvent(evName);
      }

      showToast(selectedPlayers.length + ' participant(s) updated for ' + meta.header + '!', 'success');
      invalidateCache();
      closeOcrModal();
    } catch (err: any) {
      console.error('Commit Event OCR error:', err);
      showToast('Failed to save event OCR updates: ' + (err.message || err), 'error');
    } finally {
      btnCommit.disabled = false;
      const finalSpan = btnCommit.querySelector('span');
      if (finalSpan) finalSpan.textContent = 'Validate & Apply Updates';
    }
    return;
  }

  const selectedExistingIndices: number[] = [];
  if (tbody)
    tbody
      .querySelectorAll('.ocr-row-cb:checked')
      .forEach((cb) => selectedExistingIndices.push(parseInt(cb.getAttribute('data-index') || '0', 10)));
  const selectedNewIndices: number[] = [];
  if (tbodyNew)
    tbodyNew
      .querySelectorAll('.ocr-row-cb:checked')
      .forEach((cb) => selectedNewIndices.push(parseInt(cb.getAttribute('data-index') || '0', 10)));
  // Never send an R5 for removal, whatever the table held (the database
  // refuses it too, migration 20260930182821).
  const r5Pseudos = new Set(
    getGuildMembers()
      .filter((m: any) => m && m.role === 'R5')
      .map((m: any) => String(m.pseudo).toLowerCase())
  );
  const checkedRemovalPseudos: string[] = [];
  if (tbodyRemoved)
    tbodyRemoved.querySelectorAll('.ocr-removal-cb:checked').forEach((cb) => {
      const p = cb.getAttribute('data-removal-pseudo');
      if (p && !r5Pseudos.has(p.toLowerCase())) checkedRemovalPseudos.push(p);
    });

  if (selectedExistingIndices.length === 0 && selectedNewIndices.length === 0 && checkedRemovalPseudos.length === 0) {
    showToast('No players selected.', 'error');
    return;
  }

  const selectedExisting = selectedExistingIndices.map((idx) => extracted[idx]).filter(Boolean);
  let selectedNew = selectedNewIndices.map((idx) => extracted[idx]).filter(Boolean);

  const invalidUidPseudos: string[] = [];
  const newUidSeen = new Set<string>();
  const duplicateNewUids: string[] = [];
  for (const np of selectedNew) {
    const uidVal = String(np.uid || '').trim();
    if (uidVal) {
      const uidErr = validateUid(uidVal);
      if (uidErr) invalidUidPseudos.push(np.pseudo + ' (' + uidVal + ')');
      else if (newUidSeen.has(uidVal)) duplicateNewUids.push(uidVal);
      else newUidSeen.add(uidVal);
    }
  }
  if (invalidUidPseudos.length > 0) {
    showToast('Invalid UID for: ' + invalidUidPseudos.join(', '), 'error');
    return;
  }
  if (duplicateNewUids.length > 0) {
    showToast('Duplicate UID in batch: ' + duplicateNewUids.join(', '), 'error');
    return;
  }

  if (newUidSeen.size > 0) {
    btnCommit.disabled = true;
    const preSpan = btnCommit.querySelector('span');
    if (preSpan) preSpan.textContent = 'Checking UIDs...';
    const client = db();
    const collidingUidInfo: Record<string, any> = {};
    const bannedUidSet = new Set<string>();
    const targetUids = Array.from(newUidSeen);

    // This used to be a strictly sequential `for` loop doing THREE round trips
    // per UID (collision probe, player lookup, ban check). A 100-player roster
    // import meant 200-300 serialised requests -- roughly 16-24s of frozen UI
    // behind a "Checking UIDs…" label, growing linearly with the batch.
    //
    // The ban check is one query for the whole batch, and the collision probes
    // run 10 at a time through the same `runInChunks` helper this file already
    // uses in five other places. Same results, same error tolerance (a failed
    // probe is still swallowed per UID, never failing the whole commit).
    try {
      const banRes = await findBannedUids(client, targetUids);
      ((banRes && banRes.data) || []).forEach((row: any) => {
        const u = String(row && row.uid ? row.uid : '').trim();
        if (u) bannedUidSet.add(u);
      });
    } catch (_) {
      /* warned */
    }

    await runInChunks(targetUids, 10, async (targetUid: string) => {
      try {
        const chkRes = await checkUidExistsGlobally(client, targetUid);
        if (chkRes && chkRes.data === true) {
          try {
            const l = await findPlayerByUid(client, targetUid);
            collidingUidInfo[targetUid] = l && l.data && l.data.ok ? l.data : null;
          } catch (_) {
            collidingUidInfo[targetUid] = null;
          }
        }
      } catch (_) {
        /* warned in legacy */
      }
    });
    const collidingLabels: string[] = [];
    const bannedLabels: string[] = [];
    if (Object.keys(collidingUidInfo).length > 0 || bannedUidSet.size > 0) {
      selectedNew = selectedNew.filter((np: any) => {
        const uidVal = String(np.uid || '').trim();
        if (!uidVal) return true;
        if (bannedUidSet.has(uidVal)) {
          bannedLabels.push(np.pseudo + ' (' + uidVal + ')');
          return false;
        }
        if (Object.hasOwn(collidingUidInfo, uidVal)) {
          const info = collidingUidInfo[uidVal];
          const ownerGuild = info && info.player && info.player.guild ? info.player.guild : '?';
          collidingLabels.push(np.pseudo + ' (already in ' + ownerGuild + ')');
          return false;
        }
        return true;
      });
    }
    if (collidingLabels.length > 0 || bannedLabels.length > 0) {
      const parts: string[] = [];
      if (collidingLabels.length > 0)
        parts.push('UID already registered — ' + collidingLabels.join(', ') + '. Resolve via Add Member.');
      if (bannedLabels.length > 0) parts.push('Banned — ' + bannedLabels.join(', ') + '.');
      showToast('Skipped: ' + parts.join(' '), 'error');
      if (selectedExisting.length === 0 && selectedNew.length === 0 && checkedRemovalPseudos.length === 0) {
        btnCommit.disabled = false;
        if (preSpan) preSpan.textContent = 'Validate & Apply Updates';
        return;
      }
    }
  }

  const run = (): Promise<void> =>
    executeRosterCommit(selectedExisting, selectedNew, checkedRemovalPseudos, targetField);

  if (checkedRemovalPseudos.length > 0) {
    const listPreview =
      checkedRemovalPseudos
        .slice(0, 8)
        .map((p) => esc(p))
        .join(', ') + (checkedRemovalPseudos.length > 8 ? ' and ' + (checkedRemovalPseudos.length - 8) + ' more' : '');
    const confirmMsg =
      'Are you sure you want to permanently remove <strong>' +
      checkedRemovalPseudos.length +
      ' member(s)</strong> (' +
      listPreview +
      ')?<br><br><span class="u-c-hexf87171 u-fs-fs-base">This permanently deletes the member and their event participations, shadowfront squads, weekly scores and sanctions.</span>';
    if (btnCommit) btnCommit.disabled = true;
    showConfirm(
      'Confirm Roster Removals',
      confirmMsg,
      () => {
        void run();
      },
      () => {
        if (btnCommit) {
          btnCommit.disabled = false;
          const span = btnCommit.querySelector('span');
          if (span) span.textContent = 'Validate & Apply Updates';
        }
      }
    );
  } else {
    await run();
  }
}

export async function executeRosterCommit(
  selectedExisting: any[],
  selectedNew: any[],
  checkedRemovalPseudos: string[],
  targetField: string
): Promise<void> {
  const btnCommit = byId<HTMLButtonElement>('ocr-commit-btn');
  if (btnCommit) {
    btnCommit.disabled = true;
    const span = btnCommit.querySelector('span');
    if (span) span.textContent = 'Validating & Saving...';
  }

  const metric = getCurrentOcrMetric();
  const meta = getOcrMeta(metric);

  try {
    const bulkRank = (rank: unknown): string | undefined =>
      typeof rank === 'string' && isRoleAllowedForBulk(rank) ? rank : undefined;
    const roster = members();

    // All of it or none of it (M4a, owner decision 2026-10-03): the import is
    // one database transaction. A refused row -- a UID already taken, a
    // banned one, an R5 removal -- now refuses the whole import and names the
    // row, where it used to be skipped, counted, and the rest applied.
    const existingRows = selectedExisting
      .map((sp: any) => {
        const existing = roster.find((m: any) => String(m.pseudo).toLowerCase() === String(sp.pseudo).toLowerCase());
        if (!existing) return null;
        const row: { pseudo: string; score: number; role?: string } = {
          pseudo: existing.pseudo,
          score: sp.score != null ? sp.score : sp.overall_power || 0,
        };
        // A rank is only read by the Members OCR, and never overrides an R5.
        const rank = metric === 'members' && targetField !== 'glory_score' ? bulkRank(sp.rank) : undefined;
        if (rank && existing.role !== 'R5') row.role = rank;
        return row;
      })
      .filter(Boolean) as Array<{ pseudo: string; score: number; role?: string }>;

    const newRows = selectedNew.map((np: any) => ({
      pseudo: np.pseudo,
      uid: np.uid && String(np.uid).trim() ? String(np.uid).trim() : null,
      score: np.score != null ? np.score : np.overall_power || 0,
      role: bulkRank(np.rank) || 'R1',
    }));

    const result = await commitOcrRoster(targetField, existingRows, newRows, checkedRemovalPseudos);
    const updatedCount = result.updated;
    const addedCount = result.added;
    const removedCount = result.removed;
    const rankAssignedCount = result.ranks_assigned;
    const failedCount = 0;

    await fetchGuildMembers();
    renderGuildMembers();
    closeOcrModal();

    let summaryMsg: string;
    if (metric === 'members') {
      summaryMsg = 'Updated ' + updatedCount + ' · Added ' + addedCount + ' · Removed ' + removedCount;
      if (rankAssignedCount > 0) summaryMsg += ' · Ranks assigned ' + rankAssignedCount;
    } else {
      const tagInput = byId<HTMLInputElement>('ocr-guild-tag-input');
      const activeTag = tagInput && tagInput.value.trim() ? tagInput.value.trim() : '';
      const curDiff = categorizeOcrDiff(
        getOcrExtractedPlayers(),
        members(),
        activeTag,
        targetField,
        meta.isMultiGuild,
        'metric'
      );
      const skippedCount = curDiff.unknown && curDiff.unknown.length ? curDiff.unknown.length : 0;
      summaryMsg =
        'Updated ' +
        updatedCount +
        (skippedCount > 0 ? ' · Skipped ' + skippedCount + ' not in roster (use Members OCR)' : '');
    }
    if (failedCount > 0) summaryMsg += ' · Failed ' + failedCount;
    showToast(summaryMsg, failedCount > 0 ? 'warning' : 'success');
    invalidateCache();
  } catch (err: any) {
    console.error('Commit OCR error:', err);
    // The import is all-or-nothing: say so, so nobody re-checks half a roster.
    showToast('Nothing was saved: ' + (err.message || err), 'error');
  } finally {
    if (btnCommit) {
      btnCommit.disabled = false;
      const finalSpan = btnCommit.querySelector('span');
      if (finalSpan) finalSpan.textContent = 'Validate & Apply Updates';
    }
  }
}

function invalidateCache(): void {
  cache.invalidate();
}
