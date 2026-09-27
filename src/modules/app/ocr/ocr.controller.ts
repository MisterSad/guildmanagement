/**
 * src/modules/app/ocr/ocr.controller.ts
 *
 * Sous-lot 6.7 (Strangler) — OCR modal lifecycle, dropdown/timezone collapsible,
 * video frame extraction, file handling, the ocr-guild-members Edge call, and
 * the roster/event commit flow ported from app.js. Reuses the pure helpers in
 * src/modules/ocr/ocr.service.ts. All feedback via dialogs.service; removal
 * confirmation via window.showConfirm; extracted values escaped by the renderer.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { esc, winAny, byId, gm } from '../admin/utils';
import { showToast } from '../dialogs/dialogs.service';
import { getGuildMembers } from '../members/members.store';
import { renderGuildMembers } from '../members/members.render';
import {
  ocrDownsampleEvenly,
  upsertPlayerMetrics,
  categorizeOcrDiff,
  parseOcrScore,
  compressImageForUpload,
  fuseOcrPlayers,
  ocrProfileFromRoi,
  ocrEstimateProfileShift,
  ocrMeasureVerticalSharpness
} from '../../ocr/ocr.service';
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
  setOcrScanDay
} from './ocr.meta';
import { renderOcrResults, toggleAllCheckboxes } from './ocr.render';
import { EventsService } from '../../events/events.service';
import { eventsView } from '../../events/views/EventsView';
import { armsRaceView } from '../../armsrace/views/ArmsRaceView';
import { shadowfrontView } from '../../shadowfront/views/ShadowfrontView';

export { getOcrModel };

/** War prep metric commit target: event name + day container (0 = aggregate). */
interface WarOcrDayTarget { eventName: 'SvS' | 'GvG'; day: number }

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

function w(): any {
  return winAny();
}
function db(): any {
  const x = gm();
  return x && x.db ? x.db : null;
}
function currentGuild(): string {
  const x = gm();
  return x && typeof x.getActiveGuild === 'function' ? x.getActiveGuild() : 'members';
}
function members(): any[] {
  return getGuildMembers();
}
function runInChunks<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const x = gm();
  if (x && typeof x.runInChunks === 'function') return x.runInChunks(items, size, fn);
  return (async () => {
    for (let i = 0; i < items.length; i += size) {
      await Promise.all(items.slice(i, i + size).map((it) => fn(it)));
    }
  })();
}
function getWeekStart(d?: unknown): string {
  const x = gm();
  if (x && typeof x.getWeekStart === 'function') return x.getWeekStart(d);
  const date = d ? new Date(d as any) : new Date();
  const day = date.getUTCDay();
  const diff = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - diff);
  return date.toISOString().slice(0, 10);
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
    (btn as HTMLElement).style.background = isActive ? (OCR_METRICS_META[m] ? OCR_METRICS_META[m].color : 'var(--accent)') : 'transparent';
    (btn as HTMLElement).style.color = isActive ? '#fff' : 'var(--text-muted)';
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
  if (rankHeader) rankHeader.style.display = (active === 'members') ? '' : 'none';

  const scopeBadge = byId('ocr-scope-badge');
  const scopeDesc = byId('ocr-scope-desc');
  const tagInputGroup = byId('ocr-tag-input-group');
  const tagInput = byId<HTMLInputElement>('ocr-guild-tag-input');

  let configuredTag = '';
  const x = gm();
  if (x && typeof x.getGuildTag === 'function') configuredTag = await x.getGuildTag();
  if (tagInput && (!tagInput.value || tagInput.dataset.autoFilled === 'true')) {
    tagInput.value = configuredTag || '';
    tagInput.dataset.autoFilled = 'true';
  }

  if (meta.isMultiGuild) {
    if (scopeBadge) { scopeBadge.innerHTML = '<i class="ph ph-globe"></i> Leaderboard (Tag Filtered)'; scopeBadge.style.background = 'rgba(234,179,8,0.18)'; scopeBadge.style.color = '#facc15'; }
    if (scopeDesc) scopeDesc.textContent = 'Screenshots contain multi-guild players. Targeting members with tag ' + ((tagInput && tagInput.value) ? tagInput.value : configuredTag) + '.';
    if (tagInputGroup) tagInputGroup.style.display = 'flex';
  } else if (meta.isEvent) {
    if (scopeBadge) { scopeBadge.innerHTML = '<i class="' + (meta.icon || 'ph-sword') + '"></i> Event Session Scan'; scopeBadge.style.background = 'rgba(99,102,241,0.18)'; scopeBadge.style.color = meta.color || 'var(--accent)'; }
    if (scopeDesc) scopeDesc.textContent = meta.subtitle || 'Screenshots will update event participants for active session.';
    if (tagInputGroup) tagInputGroup.style.display = 'none';
  } else {
    if (scopeBadge) { scopeBadge.innerHTML = '<i class="ph ph-shield-check"></i> Intra-Guild Scan'; scopeBadge.style.background = 'rgba(99,102,241,0.18)'; scopeBadge.style.color = 'var(--accent)'; }
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

export async function openOcrModal(metric?: string): Promise<void> {
  initOcrGeminiModule();
  await setOcrMetric(metric || 'power');
  const modal = byId('ocr-modal-overlay');
  if (modal) {
    modal.style.display = 'flex';
    modal.classList.add('visible');
    resetOcrModalState();
  }
}

export function closeOcrModal(): void {
  const modal = byId('ocr-modal-overlay');
  if (modal) {
    modal.classList.remove('visible');
    modal.style.display = 'none';
  }
  const confirmOverlay = typeof document !== 'undefined' ? document.getElementById('confirm-overlay') : null;
  if (confirmOverlay) {
    confirmOverlay.remove();
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

  const closeMenu = (): void => { menu.style.display = 'none'; menu.classList.remove('show'); trigger.setAttribute('aria-expanded', 'false'); };
  const openMenu = (): void => { menu.style.display = 'flex'; menu.classList.add('show'); trigger.setAttribute('aria-expanded', 'true'); };
  const isOpen = (): boolean => menu.classList.contains('show') || menu.style.display === 'flex';
  const toggleMenu = (): void => { if (isOpen()) closeMenu(); else openMenu(); };

  trigger.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleMenu(); });
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
      const x = gm();
      label.textContent = ((x && typeof x.t === 'function' ? x.t(key) : fallback)) || fallback;
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

  return { expand: () => update(true), collapse: () => update(false), isExpanded: () => toggle.getAttribute('aria-expanded') === 'true' };
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
  if (metricTabs) metricTabs.querySelectorAll('.gm-seg-btn').forEach((btn) => btn.addEventListener('click', () => { void setOcrMetric(btn.getAttribute('data-metric') || 'members'); }));

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
          scopeDesc.textContent = 'Day ' + d + ' screenshots — scores are imported into the Day ' + d + ' column of the preparation grid.';
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
      if (meta && meta.isMultiGuild && scopeDesc) scopeDesc.textContent = 'Screenshots contain multi-guild players. Targeting members with tag ' + (tagInput.value || '[TAG]') + '.';
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', closeOcrModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeOcrModal);
  const overlay = byId('ocr-modal-overlay');
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOcrModal(); });

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = '#818cf8'; dropzone.style.background = 'rgba(99, 102, 241, 0.08)'; });
    dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = 'rgba(99, 102, 241, 0.4)'; dropzone.style.background = 'rgba(99, 102, 241, 0.03)'; });
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
  if (btnSelectAll && cbToggleAll) btnSelectAll.addEventListener('click', () => { cbToggleAll.checked = !cbToggleAll.checked; toggleAllCheckboxes(cbToggleAll.checked); });
  if (cbToggleAll) cbToggleAll.addEventListener('change', () => toggleAllCheckboxes(cbToggleAll.checked));
  if (btnCommit) btnCommit.addEventListener('click', () => { void commitOcrUpdates(); });
}

// ── Video → frames ───────────────────────────────────────────────────────────

// The ROI is sampled into a 64 x 256 canvas: wide enough to average away
// per-pixel noise, tall enough to locate a scroll to under two source pixels.
const OCR_ROI_SAMPLE_W = 64;
const OCR_ROI_SAMPLE_H = 256;

/**
 * Fraction of a frame height that must scroll past before another frame is
 * kept. The remainder is the guaranteed overlap between two consecutive kept
 * frames, so no row can fall between them unread.
 *
 * Swept against an 88 s, 147-row roster recording, scoring every row for
 * whether some kept frame showed it whole:
 *
 *     0.76 -> 60 frames, 145 whole, 1 never seen
 *     0.70 -> 64 frames, 146 whole, 0 never seen   <- chosen
 *     0.58 -> 74 frames, 146 whole, 0 never seen
 *
 * It is not perfectly monotonic -- 0.64 lands a commit badly and loses a row --
 * so this is a measured choice on real footage, not a derived constant. The
 * value has to absorb the fact that ocrEstimateProfileShift under-reports
 * travel on a periodic list rather than risk an alias, so the true overlap is
 * larger than 1 - 0.70 suggests.
 *
 * For scale: the old time-based selection kept 35 frames and read 131 of the
 * 147 rows. This keeps 64 and reads 146. Frame count was never the lever --
 * which frames were kept was.
 */
const OCR_VIDEO_ADVANCE_FRACTION = 0.70;
/** Below this, the window may still commit its sharpest candidate. */
const OCR_VIDEO_EARLY_COMMIT = 0.65;
/** A correlation this poor means the view changed, not scrolled. */
const OCR_VIDEO_SCENE_CUT_SCORE = 0.5;

interface OcrRoiSample {
  profile: number[];
  sharpness: number;
}

/** Samples the central scrollable ROI: its row profile and its vertical detail. */
function ocrSampleRoi(roiCtx: CanvasRenderingContext2D, video: HTMLVideoElement): OcrRoiSample {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  // Region of Interest: middle 72% height (skipping top 16% banner and bottom 12% footer/chat)
  const sx = Math.round(vw * 0.05);
  const sy = Math.round(vh * 0.16);
  const sw = Math.max(1, Math.round(vw * 0.90));
  const sh = Math.max(1, Math.round(vh * 0.72));

  roiCtx.drawImage(video, sx, sy, sw, sh, 0, 0, OCR_ROI_SAMPLE_W, OCR_ROI_SAMPLE_H);
  const data = roiCtx.getImageData(0, 0, OCR_ROI_SAMPLE_W, OCR_ROI_SAMPLE_H).data;
  return {
    profile: ocrProfileFromRoi(data, OCR_ROI_SAMPLE_W, OCR_ROI_SAMPLE_H),
    sharpness: ocrMeasureVerticalSharpness(data, OCR_ROI_SAMPLE_W, OCR_ROI_SAMPLE_H),
  };
}

export function extractFramesFromVideo(
  file: Blob,
  opts?: { stepMs?: number; maxDurationSec?: number; maxOutputWidth?: number; maxFrames?: number }
): Promise<Blob[]> {
  const o = opts || {};
  const stepMs = o.stepMs || 150;
  const maxDurationSec = o.maxDurationSec || 480;
  const maxOutputWidth = o.maxOutputWidth || 1600;
  // Was 35, which is below what a normal scan produces: measured on an 88 s,
  // 147-row roster recording, the detector kept 86 frames and the cap threw 51
  // of them away by even decimation, leaving 16 of the 147 rows impossible to
  // read (5 never shown at all, 11 only ever cut across a frame edge). The
  // detector itself covered 145 of 147. The cap was the defect, not the
  // detection. This is now a safety ceiling against a pathological recording,
  // not a budget: nothing about a normal scan should ever reach it.
  const maxFrames = o.maxFrames || 600;

  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.style.cssText = 'position:fixed; left:-9999px; top:0; width:2px; height:2px; opacity:0.01; pointer-events:none;';
    video.setAttribute('aria-hidden', 'true');
    document.body.appendChild(video);
    const url = URL.createObjectURL(file);
    let settled = false;

    const cleanup = (): void => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      if (video.parentNode) video.parentNode.removeChild(video);
    };
    const fail = (err: any): void => { if (settled) return; settled = true; cleanup(); reject(err); };

    video.addEventListener('error', () => {
      const mediaErr = video.error;
      const err: any = new Error('video_unsupported');
      err.mediaErrorCode = mediaErr ? mediaErr.code : null;
      err.mediaErrorMessage = mediaErr ? mediaErr.message : null;
      err.fileType = file.type || null;
      fail(err);
    });

    video.addEventListener('loadedmetadata', () => {
      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) { fail(new Error('video_invalid')); return; }
      if (duration > maxDurationSec) { fail(new Error('video_too_long')); return; }
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) { fail(new Error('video_invalid')); return; }

      const scale = Math.min(1, maxOutputWidth / vw);
      const outW = Math.max(1, Math.round(vw * scale));
      const outH = Math.max(1, Math.round(vh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = outW; canvas.height = outH;
      const ctx = canvas.getContext('2d');
      const roiCanvas = document.createElement('canvas');
      roiCanvas.width = OCR_ROI_SAMPLE_W; roiCanvas.height = OCR_ROI_SAMPLE_H;
      const roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || !roiCtx) { fail(new Error('video_invalid')); return; }

      // A seek that never fires `seeked` used to leave this promise pending for
      // good, and the modal with it: seeking to exactly `duration`, or to a
      // timestamp the browser clamps to the one it is already at, emits no
      // event at all. The timeout resolves the step instead of stalling the
      // whole scan -- a frame drawn twice costs one duplicate row, which
      // fuseOcrPlayers already collapses.
      const SEEK_TIMEOUT_MS = 3000;
      const seekTo = (t: number): Promise<void> => new Promise((res) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          video.removeEventListener('seeked', onSeeked);
          // Allow GPU video decoding buffer to settle before canvas draw
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => res());
          } else {
            setTimeout(res, 10);
          }
        };
        const onSeeked = (): void => { finish(); };
        const timer = setTimeout(finish, SEEK_TIMEOUT_MS);
        video.addEventListener('seeked', onSeeked);
        video.currentTime = t;
      });

      const captureFrameBlob = async (): Promise<Blob | null> => {
        ctx.drawImage(video, 0, 0, outW, outH);
        return new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
      };

      void (async () => {
        try {
          const kept: Blob[] = [];

          // How far the content has scrolled, in ROI sample rows, since the
          // frame that was last kept. Displacement is what decides when to keep
          // another frame, because it is the only quantity that answers the
          // question that matters: could a row have passed by unseen?
          const advanceTarget = OCR_ROI_SAMPLE_H * OCR_VIDEO_ADVANCE_FRACTION;
          const earlyCommit = advanceTarget * OCR_VIDEO_EARLY_COMMIT;
          // One step may not move the content more than the ROI, or the
          // correlation would be free to lock onto the wrong row of a roster
          // that repeats every row pitch.
          const maxStepShift = Math.round(OCR_ROI_SAMPLE_H * 0.45);

          let prevProfile: number[] | null = null;
          let travelled = 0;
          let bestBlob: Blob | null = null;
          let bestSharpness = -1;
          let bestTravelled = 0;

          const commit = async (blob: Blob | null, consumed: number): Promise<void> => {
            const b = blob || await captureFrameBlob();
            if (b) kept.push(b);
            travelled = Math.max(0, travelled - consumed);
            bestBlob = null;
            bestSharpness = -1;
            bestTravelled = 0;
          };

          const steps = Math.max(1, Math.ceil((duration * 1000) / stepMs));

          for (let s = 0; s <= steps; s++) {
            const t = Math.min(duration, (s * stepMs) / 1000);
            await seekTo(t);

            const sample = ocrSampleRoi(roiCtx, video);
            const isStart = (s === 0);
            const isEnd = (t >= duration - 0.08);

            if (isStart) {
              // Always capture the very first frame (top of leaderboard)
              const blob = await captureFrameBlob();
              if (blob) kept.push(blob);
            } else {
              const { shift, score } = ocrEstimateProfileShift(prevProfile, sample.profile, maxStepShift);

              if (score < OCR_VIDEO_SCENE_CUT_SCORE) {
                // Not a scroll: the view itself changed (a tab switch, a dialog,
                // a jump to another list). Nothing carries over, so keep this
                // frame outright and start measuring again from here.
                await commit(null, travelled);
              } else {
                travelled += Math.abs(shift);

                // Past the early-commit mark every frame is a legitimate
                // candidate, so keep the crispest one rather than whichever
                // happens to land on the threshold.
                if (travelled >= earlyCommit && sample.sharpness > bestSharpness) {
                  const candidate = await captureFrameBlob();
                  if (candidate) {
                    bestBlob = candidate;
                    bestSharpness = sample.sharpness;
                    bestTravelled = travelled;
                  }
                }

                if (travelled >= advanceTarget) {
                  await commit(bestBlob, bestTravelled || travelled);
                }
              }
            }

            if (isEnd) {
              // The tail of the list lives only on the last frame, and it has
              // not necessarily scrolled a full advance since the previous one.
              if (travelled > 0 || kept.length === 0) {
                const blob = await captureFrameBlob();
                if (blob) kept.push(blob);
              }
              break;
            }

            prevProfile = sample.profile;
            if (t >= duration) break;
          }

          if (settled) return;
          settled = true;
          cleanup();

          if (kept.length === 0) { reject(new Error('video_no_frames')); return; }

          // Cap cleanly if recording was unusually long without blind drop
          const finalKept = kept.length > maxFrames ? ocrDownsampleEvenly(kept, maxFrames) : kept;
          resolve(finalKept);
        } catch (err) { fail(err); }
      })();
    });

    video.src = url;
    video.load();
  });
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

  if (videoFiles.length > 0) {
    if (loadingH4) loadingH4.textContent = 'Scanning video for new content...';
    for (let v = 0; v < videoFiles.length; v++) {
      if (loadingP) loadingP.textContent = videoFiles.length > 1 ? 'Extracting frames from video ' + (v + 1) + ' of ' + videoFiles.length + '...' : 'Extracting frames from your video — this can take a moment...';
      try {
        const frameBlobs = await extractFramesFromVideo(videoFiles[v]);
        imageFiles = imageFiles.concat(frameBlobs);
      } catch (err: any) {
        console.error('Video frame extraction failed:', err);
        let msg = 'Could not process the video. Try an MP4/MOV recording, or use screenshots instead.';
        if (err && err.message === 'video_too_long') msg = 'Video is too long (max 8 minutes) — trim it or use screenshots instead.';
        else if (err && err.message === 'video_unsupported') {
          const isDecodeFailure = (err.mediaErrorCode === 3 || err.mediaErrorCode === 4);
          msg = isDecodeFailure ? "This browser couldn't decode the video — either its codec (e.g. HEVC/H.265) isn't supported, or it's too large/high-resolution to process. Try a shorter recording, re-export as H.264, or use screenshots instead." : 'This video format could not be read. Try MP4, or use screenshots instead.';
        } else if (err && err.message === 'video_no_frames') msg = 'No distinct frames were found in that video.';
        showToast(msg, 'error');
        if (loading) loading.style.display = 'none';
        if (dropzone) dropzone.style.display = 'block';
        return;
      }
    }
  }

  // Safety ceiling, not a budget. ocrDownsampleEvenly drops frames blindly, and
  // every frame it drops is a screenful of players that no longer reaches the
  // OCR -- measured at the old cap of 60 (and the extractor's own 35), a single
  // 88 s roster recording lost 16 of its 147 rows. Images are compressed one
  // batch at a time below, so a long scan costs requests and time, never a
  // decimated roster.
  const MAX_OCR_IMAGES = 500;
  if (imageFiles.length > MAX_OCR_IMAGES) {
    showToast(
      'That is ' + imageFiles.length + ' images — scanning the first ' + MAX_OCR_IMAGES +
      ' evenly spread across the set. Split the recording in two to scan all of it.',
      'warning'
    );
    imageFiles = ocrDownsampleEvenly(imageFiles, MAX_OCR_IMAGES);
  }

  const metric = getCurrentOcrMetric();
  const meta = getOcrMeta(metric);
  const tagInput = byId<HTMLInputElement>('ocr-guild-tag-input');
  let activeGuildTag = '';
  if (tagInput && tagInput.value.trim()) activeGuildTag = tagInput.value.trim();
  else { const x = gm(); if (x && typeof x.getGuildTag === 'function') activeGuildTag = await x.getGuildTag(); }

  // Lazy roster prefetch: if the in-memory store is empty (user opened OCR
  // from an event/GvG/SvS tab without first visiting the Members tab), we
  // silently fetch the roster so that fuseOcrPlayers and renderOcrResults
  // can match member pseudos correctly against guild members.
  // This is a no-op when the roster is already loaded (normal flow).
  if (members().length === 0) {
    try {
      if (loadingP) loadingP.textContent = 'Loading guild roster for member matching…';
      await fetchGuildMembers();
    } catch (_) { /* best-effort — OCR proceeds even without roster */ }
  }

  if (loadingH4) loadingH4.textContent = 'Analyzing screenshots with AI OCR (' + meta.header + ')...';

  let allPlayers: any[] = [];
  try {
    // Calibrated chunk size = 2 images per prompt to maximize Gemini vision accuracy
    const chunkSize = 2;
    const chunks: Blob[][] = [];
    for (let c = 0; c < imageFiles.length; c += chunkSize) chunks.push(imageFiles.slice(c, c + chunkSize));

    // Compression is per batch, immediately before that batch is sent, rather
    // than for every image up front. The old Promise.all held one base64 data
    // URL per image alive at the same time; at the frame counts a video now
    // produces that is tens of megabytes of strings on a phone, and lifting the
    // image cap without this would only trade missing players for an OOM.
    const prepareChunk = async (blobs: Blob[]): Promise<any[]> => Promise.all(
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
      blobs: Blob[], rank: string | null, onStatus?: (s: string) => void
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
          loadingP.textContent = 'Processing screenshots batch ' + (b + 1) + ' of ' + chunks.length + ' (' + imageFiles.length + ' total images)...';
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
            loadingP.textContent = 'Processed batch ' + completedChunks + ' of ' + chunks.length + ' (' + imageFiles.length + ' total images)...';
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
        batchErrors.length + ' of ' + chunks.length + ' batches failed. The table below is incomplete: review it before committing, or re-run the scan.',
        'warning'
      );
    }

    // Multi-frame deduplication and fusion
    const roster = members();
    const fused = fuseOcrPlayers(allPlayers, roster, activeGuildTag);

    setOcrExtractedPlayers(fused);
    renderOcrResults(getOcrExtractedPlayers());
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
    default:
      return code || 'OCR analysis failed. Please try again.';
  }
}

export async function callGeminiOcrBatchApi(
  batchImageItems: any[], metricType: string, guildTag: string, rankHint: string | null | ((s: string) => void), updateStatusCallback?: (s: string) => void
): Promise<{ players: any[]; endingRank: string | null }> {
  if (typeof guildTag === 'function') { updateStatusCallback = guildTag as any; rankHint = null; guildTag = ''; }
  else if (typeof rankHint === 'function') { updateStatusCallback = rankHint as any; rankHint = null; }
  metricType = metricType || 'power';
  guildTag = guildTag || '';
  const client = db();
  if (!client || !client.functions) throw new Error('OCR service unavailable. Please sign in and try again.');

  if (updateStatusCallback) updateStatusCallback('Analyzing with AI OCR (' + metricType.toUpperCase() + (guildTag ? ' ' + guildTag : '') + ')...');
  // Per-day war metrics attach the validated scan-day target to the metadata
  // object (the Edge Function re-validates it through the Zod scanDay enum).
  let metadata: { scanDay: number } | undefined;
  if (metricType === 'svs_day' || metricType === 'gvg_day') metadata = { scanDay: getOcrScanDay() };
  const res = await client.functions.invoke('ocr-guild-members', { body: { images: batchImageItems, metricType, guildTag, rankHint: rankHint || null, metadata } });
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
  const errMsg = (res.data && res.data.error) || (res.error && res.error.message) || 'OCR analysis failed. Please try again.';
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
    tbody.querySelectorAll('.ocr-row-cb:checked').forEach((cb) => selectedIndices.push(parseInt(cb.getAttribute('data-index') || '0', 10)));
    if (selectedIndices.length === 0) { showToast('No players selected.', 'error'); return; }
    const selectedPlayers = selectedIndices.map((idx) => extracted[idx]).filter(Boolean);
    btnCommit.disabled = true;
    const span = btnCommit.querySelector('span');
    if (span) span.textContent = 'Validating & Saving...';

    try {
      const client = db();
      const currentG = currentGuild();
      if (meta.eventType === 'shadowfront') {
        const sqName = meta.squad === 'squad1' ? 'Shadowfront Squad 1' : 'Shadowfront Squad 2';
        const sqRes = await client.from('event_status').select('session_id, is_active, start_at').eq('guild', currentG).eq('event_name', sqName).maybeSingle();
        if (!sqRes.data || !sqRes.data.is_active || !sqRes.data.session_id) {
          showToast('Please start the ' + (meta.squad === 'squad1' ? 'Squad 1' : 'Squad 2') + ' session in Events before applying OCR updates.', 'error');
          return;
        }
        const activeSid = sqRes.data.session_id;
        const assignRes = await client.from('shadowfront_squads').select('pseudo, role, squad').eq('guild', currentG).eq('session_id', activeSid);
        const assignMap: Record<string, string> = {};
        (assignRes.data || []).forEach((a: any) => { assignMap[String(a.pseudo).toLowerCase()] = a.role; });
        await runInChunks(selectedPlayers, 10, async (sp: any) => {
          const role = assignMap[String(sp.pseudo).toLowerCase()];
          const updatePayload: any = { participated: 1 };
          if (role === 'reserve') updatePayload.sub_present = true;
          const upRes = await client.from('event_participants').update(updatePayload).eq('guild', currentG).eq('event_name', 'Shadowfront').eq('session_id', activeSid).eq('pseudo', sp.pseudo).select('pseudo');
          if (upRes.data && upRes.data.length === 0) {
            await client.from('event_participants').insert([Object.assign({ guild: currentG, event_name: 'Shadowfront', session_id: activeSid, pseudo: sp.pseudo, week_start: getWeekStart(sqRes.data.start_at || new Date()) }, updatePayload)]);
          }
        });
        // Phase 7: a direct call. The `window` probe silently skipped the
        // refresh whenever the namespace or method name drifted, leaving the
        // Shadowfront tab showing pre-OCR data with no error.
        await shadowfrontView.load();
      } else if (meta.eventType === 'armsrace') {
        const arEvName = meta.stage === 'stageA' ? 'ARMS RACE STAGE A' : 'ARMS RACE STAGE B';
        const arRes = await client.from('event_status').select('session_id, is_active, start_at').eq('guild', currentG).eq('event_name', arEvName).maybeSingle();
        if (!arRes.data || !arRes.data.is_active || !arRes.data.session_id) {
          showToast('Please start Arms Race ' + (meta.stage === 'stageA' ? 'Stage A' : 'Stage B') + ' session in Events before applying OCR updates.', 'error');
          return;
        }
        const arSid = arRes.data.session_id;
        await runInChunks(selectedPlayers, 10, async (sp: any) => {
          const upRes = await client.from('event_participants').update({ participated: 1 }).eq('guild', currentG).eq('event_name', arEvName).eq('session_id', arSid).eq('pseudo', sp.pseudo).select('pseudo');
          if (upRes.data && upRes.data.length === 0) {
            await client.from('event_participants').insert([{ guild: currentG, event_name: arEvName, session_id: arSid, pseudo: sp.pseudo, participated: 1, week_start: getWeekStart(arRes.data.start_at || new Date()) }]);
          }
        });
        await armsRaceView.load();
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
        const evRes = await client.from('event_status').select('session_id, is_active, start_at').eq('guild', currentG).eq('event_name', evName).maybeSingle();
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
            score: sp.score != null ? sp.score : 0
          }));
          // gm_upsert_daily_scores caps a batch at 200 rows — flush in chunks.
          for (let offset = 0; offset < rows.length; offset += 100) {
            const chunk = rows.slice(offset, offset + 100);
            const batchRes = await EventsService.upsertDailyScores(currentG, warDay.eventName, evSid, chunk);
            if (!batchRes.ok) throw new Error(batchRes.error || 'rpc_failed');
          }
        } else if (metric === 'dtr') {
          await runInChunks(selectedPlayers, 10, async (sp: any) => {
            const scoreVal = sp.score != null ? sp.score : 0;
            const updatePayload: any = {};
            if (scoreVal > 0) updatePayload.participated = 1;
            else { updatePayload.appointed = true; updatePayload.participated = 1; }
            const upRes = await client.from('event_participants').update(updatePayload).eq('guild', currentG).eq('event_name', evName).eq('session_id', evSid).eq('pseudo', sp.pseudo).select('pseudo');
            if (upRes.data && upRes.data.length === 0) {
              await client.from('event_participants').insert([Object.assign({ guild: currentG, event_name: evName, session_id: evSid, pseudo: sp.pseudo, week_start: getWeekStart(evRes.data.start_at || new Date()) }, updatePayload)]);
            }
          });
        }
        await eventsView.loadEvent(evName);
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
  if (tbody) tbody.querySelectorAll('.ocr-row-cb:checked').forEach((cb) => selectedExistingIndices.push(parseInt(cb.getAttribute('data-index') || '0', 10)));
  const selectedNewIndices: number[] = [];
  if (tbodyNew) tbodyNew.querySelectorAll('.ocr-row-cb:checked').forEach((cb) => selectedNewIndices.push(parseInt(cb.getAttribute('data-index') || '0', 10)));
  const checkedRemovalPseudos: string[] = [];
  if (tbodyRemoved) tbodyRemoved.querySelectorAll('.ocr-removal-cb:checked').forEach((cb) => { const p = cb.getAttribute('data-removal-pseudo'); if (p) checkedRemovalPseudos.push(p); });

  if (selectedExistingIndices.length === 0 && selectedNewIndices.length === 0 && checkedRemovalPseudos.length === 0) { showToast('No players selected.', 'error'); return; }

  let selectedExisting = selectedExistingIndices.map((idx) => extracted[idx]).filter(Boolean);
  let selectedNew = selectedNewIndices.map((idx) => extracted[idx]).filter(Boolean);

  const invalidUidPseudos: string[] = [];
  const newUidSeen = new Set<string>();
  const duplicateNewUids: string[] = [];
  for (const np of selectedNew) {
    const uidVal = String(np.uid || '').trim();
    if (uidVal) {
      const x = gm();
      const uidErr = x && typeof x.validateUid === 'function' ? x.validateUid(uidVal) : null;
      if (uidErr) invalidUidPseudos.push(np.pseudo + ' (' + uidVal + ')');
      else if (newUidSeen.has(uidVal)) duplicateNewUids.push(uidVal);
      else newUidSeen.add(uidVal);
    }
  }
  if (invalidUidPseudos.length > 0) { showToast('Invalid UID for: ' + invalidUidPseudos.join(', '), 'error'); return; }
  if (duplicateNewUids.length > 0) { showToast('Duplicate UID in batch: ' + duplicateNewUids.join(', '), 'error'); return; }

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
      const banRes = await client.from('banned_players').select('uid').in('uid', targetUids);
      ((banRes && banRes.data) || []).forEach((row: any) => {
        const u = String(row && row.uid ? row.uid : '').trim();
        if (u) bannedUidSet.add(u);
      });
    } catch (_) { /* warned */ }

    await runInChunks(targetUids, 10, async (targetUid: string) => {
      try {
        const chkRes = await client.rpc('check_uid_exists_globally', { p_uid: targetUid });
        if (chkRes && chkRes.data === true) {
          try { const l = await client.rpc('gm_find_player_by_uid', { p_uid: targetUid }); collidingUidInfo[targetUid] = (l && l.data && l.data.ok) ? l.data : null; }
          catch (_) { collidingUidInfo[targetUid] = null; }
        }
      } catch (_) { /* warned in legacy */ }
    });
    const collidingLabels: string[] = [];
    const bannedLabels: string[] = [];
    if (Object.keys(collidingUidInfo).length > 0 || bannedUidSet.size > 0) {
      selectedNew = selectedNew.filter((np: any) => {
        const uidVal = String(np.uid || '').trim();
        if (!uidVal) return true;
        if (bannedUidSet.has(uidVal)) { bannedLabels.push(np.pseudo + ' (' + uidVal + ')'); return false; }
        if (Object.prototype.hasOwnProperty.call(collidingUidInfo, uidVal)) {
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
      if (collidingLabels.length > 0) parts.push('UID already registered — ' + collidingLabels.join(', ') + '. Resolve via Add Member.');
      if (bannedLabels.length > 0) parts.push('Banned — ' + bannedLabels.join(', ') + '.');
      showToast('Skipped: ' + parts.join(' '), 'error');
      if (selectedExisting.length === 0 && selectedNew.length === 0 && checkedRemovalPseudos.length === 0) {
        btnCommit.disabled = false;
        if (preSpan) preSpan.textContent = 'Validate & Apply Updates';
        return;
      }
    }
  }

  const run = (): Promise<void> => executeRosterCommit(selectedExisting, selectedNew, checkedRemovalPseudos, targetField);

  if (checkedRemovalPseudos.length > 0) {
    const listPreview = checkedRemovalPseudos.slice(0, 8).map((p) => esc(p)).join(', ') + (checkedRemovalPseudos.length > 8 ? ' and ' + (checkedRemovalPseudos.length - 8) + ' more' : '');
    const confirmMsg = 'Are you sure you want to permanently remove <strong>' + checkedRemovalPseudos.length + ' member(s)</strong> (' + listPreview + ')?<br><br><span style="color:#f87171; font-size: var(--fs-base);">This permanently deletes the member and their event participations, shadowfront squads, weekly scores and sanctions.</span>';
    const confirm = w().showConfirm;
    if (typeof confirm === 'function') {
      if (btnCommit) btnCommit.disabled = true;
      confirm(
        'Confirm Roster Removals',
        confirmMsg,
        () => { void run(); },
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
  } else {
    await run();
  }
}

export async function executeRosterCommit(
  selectedExisting: any[], selectedNew: any[], checkedRemovalPseudos: string[], targetField: string
): Promise<void> {
  const btnCommit = byId<HTMLButtonElement>('ocr-commit-btn');
  if (btnCommit) {
    btnCommit.disabled = true;
    const span = btnCommit.querySelector('span');
    if (span) span.textContent = 'Validating & Saving...';
  }

  let updatedCount = 0, addedCount = 0, removedCount = 0, failedCount = 0, rankAssignedCount = 0;
  const metric = getCurrentOcrMetric();
  const meta = getOcrMeta(metric);

  try {
    const client = db();
    const currentG = currentGuild();
    const x = gm();
    const roster = members();

    await runInChunks(selectedExisting, 10, async (sp: any) => {
      const scoreVal = sp.score != null ? sp.score : (sp.overall_power || 0);
      const existing = roster.find((m: any) => String(m.pseudo).toLowerCase() === String(sp.pseudo).toLowerCase());
      if (!existing) return;

      if (targetField === 'glory_score') {
        const gloryWeek = getWeekStart();
        const glRes = await client.rpc('gm_upsert_player_glory', { p_guild: currentG, p_pseudo: existing.pseudo, p_week_start: gloryWeek, p_glory: scoreVal });
        const glRow = glRes.error ? null : (Array.isArray(glRes.data) ? glRes.data[0] : glRes.data);
        if (glRes.error || !glRow || !glRow.ok) { failedCount++; return; }
        existing.glory_score = scoreVal;
        existing.metrics_updated_at = new Date().toISOString();
        updatedCount++;
      } else {
        const updatePayload: any = {};
        updatePayload[targetField] = scoreVal;
        updatePayload.metrics_updated_at = new Date().toISOString();
        if (targetField === 'overall_power') updatePayload.power_updated_at = new Date().toISOString();
        let rankChanged = false;
        if (metric === 'members' && sp.rank && x && typeof x.isRoleAllowedForBulk === 'function' && x.isRoleAllowedForBulk(sp.rank) && existing.role !== 'R5') {
          updatePayload.role = sp.rank;
          rankChanged = sp.rank !== existing.role;
        }
        const upRes = await client.from('guild_members').update(updatePayload).eq('guild', currentG).eq('pseudo', existing.pseudo);
        if (upRes.error) { failedCount++; return; }
        existing[targetField] = scoreVal;
        existing.metrics_updated_at = updatePayload.metrics_updated_at;
        if (updatePayload.role) existing.role = updatePayload.role;
        if (rankChanged) rankAssignedCount++;
        updatedCount++;
      }

      try {
        await upsertPlayerMetrics(currentG, existing.pseudo, {
          overall_power: existing.overall_power || 0, fleet_rating: existing.fleet_rating || 0, tech_power: existing.tech_power || 0,
          flagship_power: existing.flagship_power || 0, champion_power: existing.champion_power || 0, crew_power: existing.crew_power || 0, glory_score: existing.glory_score || 0
        });
      } catch (_) { /* history snapshot best-effort */ }
    });

    await runInChunks(selectedNew, 10, async (np: any) => {
      const nScore = np.score != null ? np.score : (np.overall_power || 0);
      const assignedUid = (np.uid && String(np.uid).trim()) ? String(np.uid).trim() : ('TEMP-' + Math.random().toString(36).substring(2, 10));
      const newMember: any = {
        pseudo: np.pseudo, uid: assignedUid,
        overall_power: targetField === 'overall_power' ? nScore : 0,
        fleet_rating: targetField === 'fleet_rating' ? nScore : 0,
        tech_power: targetField === 'tech_power' ? nScore : 0,
        flagship_power: targetField === 'flagship_power' ? nScore : 0,
        champion_power: targetField === 'champion_power' ? nScore : 0,
        crew_power: targetField === 'crew_power' ? nScore : 0,
        glory_score: targetField === 'glory_score' ? nScore : 0,
        guild: currentG,
        role: (x && typeof x.isRoleAllowedForBulk === 'function' && x.isRoleAllowedForBulk(np.rank)) ? np.rank : 'R1'
      };
      if (newMember.role !== 'R1') rankAssignedCount++;
      const insRes = await client.from('guild_members').insert([newMember]);
      if (insRes.error) { failedCount++; return; }
      roster.push(newMember);
      addedCount++;

      if (targetField === 'glory_score' && nScore > 0) {
        try { await client.rpc('gm_upsert_player_glory', { p_guild: currentG, p_pseudo: newMember.pseudo, p_week_start: getWeekStart(), p_glory: nScore }); } catch (_) { /* best effort */ }
      }
      try {
        await upsertPlayerMetrics(currentG, newMember.pseudo, {
          overall_power: newMember.overall_power, fleet_rating: newMember.fleet_rating, tech_power: newMember.tech_power,
          flagship_power: newMember.flagship_power, champion_power: newMember.champion_power, crew_power: newMember.crew_power, glory_score: newMember.glory_score
        });
      } catch (_) { /* best effort */ }
    });

    if (checkedRemovalPseudos.length > 0) {
      const delRes = await client.from('guild_members').delete().eq('guild', currentG).in('pseudo', checkedRemovalPseudos);
      if (delRes.error) showToast('Error removing members: ' + delRes.error.message, 'error');
      else removedCount = checkedRemovalPseudos.length;
    }

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
      const curDiff = categorizeOcrDiff(getOcrExtractedPlayers(), members(), activeTag, targetField, meta.isMultiGuild, 'metric');
      const skippedCount = (curDiff.unknown && curDiff.unknown.length) ? curDiff.unknown.length : 0;
      summaryMsg = 'Updated ' + updatedCount + (skippedCount > 0 ? ' · Skipped ' + skippedCount + ' not in roster (use Members OCR)' : '');
    }
    if (failedCount > 0) summaryMsg += ' · Failed ' + failedCount;
    showToast(summaryMsg, failedCount > 0 ? 'warning' : 'success');
    invalidateCache();
  } catch (err: any) {
    console.error('Commit OCR error:', err);
    showToast('Failed to save OCR updates: ' + (err.message || err), 'error');
  } finally {
    if (btnCommit) {
      btnCommit.disabled = false;
      const finalSpan = btnCommit.querySelector('span');
      if (finalSpan) finalSpan.textContent = 'Validate & Apply Updates';
    }
  }
}

function invalidateCache(): void {
  const x = gm();
  if (x && x.cache && typeof x.cache.invalidate === 'function') x.cache.invalidate();
}
