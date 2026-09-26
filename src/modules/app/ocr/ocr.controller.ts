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
  ocrGridDiffRatio,
  upsertPlayerMetrics,
  categorizeOcrDiff,
  parseOcrScore,
  compressImageForUpload,
  fuseOcrPlayers,
  ocrMeasureFrameSharpness
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

const OCR_VIDEO_GRID_SIZE = 16;
const OCR_VIDEO_FRAME_DIFF_RATIO = 0.05;

/** Captures a downscaled luminance grid restricted to the central scrollable ROI. */
function ocrCaptureLuminanceGrid(gridCtx: CanvasRenderingContext2D, video: HTMLVideoElement, gridSize: number): number[] {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  // Region of Interest: middle 72% height (skipping top 16% banner and bottom 12% footer/chat)
  const sx = Math.round(vw * 0.05);
  const sy = Math.round(vh * 0.16);
  const sw = Math.max(1, Math.round(vw * 0.90));
  const sh = Math.max(1, Math.round(vh * 0.72));

  gridCtx.drawImage(video, sx, sy, sw, sh, 0, 0, gridSize, gridSize);
  const data = gridCtx.getImageData(0, 0, gridSize, gridSize).data;
  const out = new Array(gridSize * gridSize);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
  }
  return out;
}

export function extractFramesFromVideo(
  file: Blob,
  opts?: { stepMs?: number; maxDurationSec?: number; maxOutputWidth?: number; maxFrames?: number }
): Promise<Blob[]> {
  const o = opts || {};
  const stepMs = o.stepMs || 150;
  const maxDurationSec = o.maxDurationSec || 480;
  const maxOutputWidth = o.maxOutputWidth || 1600;
  const maxFrames = o.maxFrames || 35;
  const gridSize = OCR_VIDEO_GRID_SIZE;

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
      const gridCanvas = document.createElement('canvas');
      gridCanvas.width = gridSize; gridCanvas.height = gridSize;
      const gridCtx = gridCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || !gridCtx) { fail(new Error('video_invalid')); return; }

      const seekTo = (t: number): Promise<void> => new Promise((res) => {
        const onSeeked = (): void => {
          video.removeEventListener('seeked', onSeeked);
          // Allow GPU video decoding buffer to settle before canvas draw
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => res());
          } else {
            setTimeout(res, 10);
          }
        };
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
          let lastSavedGrid: number[] | null = null;
          let prevStepGrid: number[] | null = null;
          let bestStepBlobInWindow: Blob | null = null;
          let bestStepSharpnessInWindow = -1;
          let bestStepGridInWindow: number[] | null = null;
          let consecutiveMovingSteps = 0;

          const steps = Math.max(1, Math.ceil((duration * 1000) / stepMs));

          for (let s = 0; s <= steps; s++) {
            const t = Math.min(duration, (s * stepMs) / 1000);
            await seekTo(t);

            const grid = ocrCaptureLuminanceGrid(gridCtx, video, gridSize);
            const rawGridData = gridCtx.getImageData(0, 0, gridSize, gridSize).data;
            const sharpness = ocrMeasureFrameSharpness(rawGridData, gridSize, gridSize);

            const isStart = (s === 0);
            const isEnd = (t >= duration - 0.08);
            const diffFromPrev = prevStepGrid ? ocrGridDiffRatio(grid, prevStepGrid) : 1;
            const diffFromSaved = lastSavedGrid ? ocrGridDiffRatio(grid, lastSavedGrid) : 1;

            if (isStart) {
              // Always capture the very first frame (top of leaderboard)
              const blob = await captureFrameBlob();
              if (blob) kept.push(blob);
              lastSavedGrid = grid;
            } else if (isEnd) {
              // Final frame of recording
              if (diffFromSaved >= 0.04) {
                const blob = await captureFrameBlob();
                if (blob) kept.push(blob);
              }
            } else {
              // Active scroll tracking:
              const isMoving = diffFromPrev >= 0.04;
              if (isMoving) {
                consecutiveMovingSteps++;
                // Track sharpest frame seen during movement
                if (sharpness > bestStepSharpnessInWindow) {
                  bestStepSharpnessInWindow = sharpness;
                  bestStepBlobInWindow = await captureFrameBlob();
                  bestStepGridInWindow = grid;
                }

                // If continuous scrolling has lasted > 1.2s and content shifted significantly,
                // commit the sharpest frame seen so far to prevent missing intermediate players
                if (consecutiveMovingSteps >= 8 && diffFromSaved >= 0.12 && bestStepBlobInWindow) {
                  kept.push(bestStepBlobInWindow);
                  lastSavedGrid = bestStepGridInWindow || grid;
                  bestStepBlobInWindow = null;
                  bestStepSharpnessInWindow = -1;
                  consecutiveMovingSteps = 0;
                }
              } else {
                // Screen stabilized / scroll slowed or stopped (crisp stationary text)
                consecutiveMovingSteps = 0;
                if (diffFromSaved >= OCR_VIDEO_FRAME_DIFF_RATIO) {
                  const blob = await captureFrameBlob();
                  if (blob) kept.push(blob);
                  lastSavedGrid = grid;
                  bestStepBlobInWindow = null;
                  bestStepSharpnessInWindow = -1;
                }
              }
            }

            prevStepGrid = grid;
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

  const MAX_OCR_IMAGES = 60;
  if (imageFiles.length > MAX_OCR_IMAGES) {
    showToast('Processing maximum ' + MAX_OCR_IMAGES + ' images per batch (300+ players).', 'info');
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
    if (loadingP) loadingP.textContent = 'Optimizing ' + imageFiles.length + ' image(s) for AI processing...';

    // Compress all images in parallel to prevent 413 payload_too_large errors
    const imageItems: any[] = await Promise.all(
      imageFiles.map(async (file) => {
        try {
          const b64 = await compressImageForUpload(file, 1600, 0.82);
          return { mimeType: 'image/jpeg', base64Data: b64 };
        } catch (_) {
          const b64 = await fileToBase64(file);
          return { mimeType: (file as File).type || 'image/png', base64Data: b64 };
        }
      })
    );

    // Calibrated chunk size = 2 images per prompt to maximize Gemini vision accuracy
    const chunkSize = 2;
    const chunks: any[][] = [];
    for (let c = 0; c < imageItems.length; c += chunkSize) chunks.push(imageItems.slice(c, c + chunkSize));

    const isMembersMode = metric === 'members';

    if (isMembersMode) {
      // In Members mode, rank headers ("Executive Manager", "Rank 3 Members", etc.)
      // flow sequentially across batches via carryRank.
      let carryRank: string | null = null;
      for (let b = 0; b < chunks.length; b++) {
        if (loadingP) {
          loadingP.textContent = 'Processing screenshots batch ' + (b + 1) + ' of ' + chunks.length + ' (' + imageFiles.length + ' total images)...';
        }
        const batchResult = await callGeminiOcrBatchApi(chunks[b], metric, activeGuildTag, carryRank, (statusMsg: string) => {
          if (loadingP) loadingP.textContent = statusMsg;
        });
        allPlayers = allPlayers.concat(batchResult.players);
        if (batchResult.endingRank) carryRank = batchResult.endingRank;
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
          const res = await callGeminiOcrBatchApi(chunks[idx], metric, activeGuildTag, null);
          batchResults[idx] = res;
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
        const sf = w().GM_SHADOWFRONT;
        if (sf && typeof sf.load === 'function') await sf.load();
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
        const ar = w().GM_ARMSRACE;
        if (ar && typeof ar.load === 'function') await ar.load();
      } else {
        const evName = meta.eventKey;
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
        const events = w().GM_EVENTS;
        if (events && typeof events.loadEvent === 'function') await events.loadEvent(evName);
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
