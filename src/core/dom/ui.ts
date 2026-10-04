/**
 * src/core/dom/ui.ts
 *
 * Shared DOM/UI helpers ported from gm-utils.js: number input formatting, the
 * event start-date picker, Terms modal navigation, and the score trend chart
 * renderer.
 */

import { adoptDialog } from '../../components/ui/Dialog';
import { formatNumber, formatPower, escapeHTML } from '../utils/text';
import { formatChartDate, pad2 } from '../utils/date';
import { showToast } from './toast';
import { t } from '../i18n/i18n';

/** Formats a text input with thousands separators, preserving the caret. */
export function attachNumberFormatter(input: HTMLInputElement | null): void {
  if (!input || input.dataset.numFormatted === '1') return;
  input.dataset.numFormatted = '1';
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('maxlength', '13');

  if (input.value) input.value = formatNumber(input.value);

  input.addEventListener('input', () => {
    const raw = input.value;
    const cursorPos = input.selectionStart || 0;
    const digitsBefore = raw.substring(0, cursorPos).replace(/\D/g, '').length;

    const formatted = formatNumber(raw);
    input.value = formatted;

    let newPos = formatted.length;
    let count = 0;
    for (let i = 0; i < formatted.length; i++) {
      if (count >= digitsBefore) {
        newPos = i;
        break;
      }
      if (/\d/.test(formatted[i])) count++;
    }
    try {
      input.setSelectionRange(newPos, newPos);
    } catch (_) {
      /* ignore */
    }
  });
}

export interface PickEventStartOptions {
  eventLabel?: string;
  defaultVal?: string | null;
}

/** Day + time modal (interpreted in UTC). callback(isoString) or callback(null). */
export function pickEventStart(
  opts: PickEventStartOptions | undefined,
  callback: (startAt: string | null) => void
): void {
  const o = opts || {};
  const existing = document.getElementById('evt-start-overlay');
  if (existing) existing.remove();

  let now = o.defaultVal ? new Date(o.defaultVal) : new Date();
  if (isNaN(now.getTime())) now = new Date();
  const defDate = now.getUTCFullYear() + '-' + pad2(now.getUTCMonth() + 1) + '-' + pad2(now.getUTCDate());
  const defTime = pad2(now.getUTCHours()) + ':' + pad2(now.getUTCMinutes());

  const overlay = document.createElement('div');
  overlay.id = 'evt-start-overlay';
  overlay.className = 'gm-modal-overlay';
  overlay.innerHTML =
    '<div class="gm-modal-card" style="max-width: 400px; width: 90%; text-align: center;">' +
    '<div class="confirm-icon"><i class="ph ph-calendar-plus text-accent"></i></div>' +
    '<h3>' +
    t('event_start_when_title') +
    '</h3>' +
    '<p>' +
    (o.eventLabel ? '<strong>' + escapeHTML(o.eventLabel) + '</strong> - ' : '') +
    t('event_start_when_body') +
    '</p>' +
    '<div class="gm-col" style="gap:.75rem; text-align:left; margin:.25rem 0 1.2rem;">' +
    '<div class="gm-col" style="gap:.3rem;">' +
    '<label for="evt-start-date" class="gm-dim" style="font-size:.8rem;">' +
    t('event_start_date') +
    '</label>' +
    '<input type="date" id="evt-start-date" class="gm-input" value="' +
    defDate +
    '">' +
    '</div>' +
    '<div class="gm-col" style="gap:.3rem;">' +
    '<label for="evt-start-time" class="gm-dim" style="font-size:.8rem;">' +
    t('event_start_time') +
    '</label>' +
    '<input type="time" id="evt-start-time" class="gm-input" value="' +
    defTime +
    '">' +
    '</div>' +
    '</div>' +
    '<div class="confirm-actions" style="gap:1rem;">' +
    '<button id="evt-start-cancel" class="gm-btn gm-btn-ghost">' +
    t('confirm_cancel') +
    '</button>' +
    '<button id="evt-start-ok" class="gm-btn gm-btn-primary">' +
    t('event_start_confirm') +
    '</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  window.requestAnimationFrame(() => {
    overlay.classList.add('visible');
  });

  let done = false;
  const close = (result: string | null): void => {
    if (done) return;
    done = true;
    overlay.classList.remove('visible');
    setTimeout(() => {
      overlay.remove();
    }, 300);
    callback(result);
  };
  adoptDialog(overlay, { onEscape: () => close(null) });

  const cancelBtn = document.getElementById('evt-start-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => close(null));
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close(null);
  });
  const okBtn = document.getElementById('evt-start-ok');
  if (okBtn) {
    okBtn.addEventListener('click', () => {
      const dateStr = (document.getElementById('evt-start-date') as HTMLInputElement).value;
      const timeStr = (document.getElementById('evt-start-time') as HTMLInputElement).value;
      if (!dateStr || !timeStr) {
        showToast(t('event_start_invalid'), 'error');
        return;
      }
      const dm = dateStr.split('-');
      const tm = timeStr.split(':');
      const d = new Date(
        Date.UTC(
          parseInt(dm[0], 10),
          parseInt(dm[1], 10) - 1,
          parseInt(dm[2], 10),
          parseInt(tm[0], 10),
          parseInt(tm[1], 10),
          0
        )
      );
      if (isNaN(d.getTime())) {
        showToast(t('event_start_invalid'), 'error');
        return;
      }
      close(d.toISOString());
    });
  }
}

export function openTermsModal(): void {
  if (typeof window !== 'undefined') {
    window.location.href = 'terms.html';
  }
}

export function closeTermsModal(): void {
  if (typeof window === 'undefined') return;
  if (window.history && window.history.length > 1) window.history.back();
  else window.location.href = '/';
}

/** Redirects to terms.html when the URL hash is #terms (and on later changes). */
export function initTermsModal(): void {
  if (typeof window === 'undefined') return;
  if (window.location.hash === '#terms') window.location.href = 'terms.html';
  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#terms') window.location.href = 'terms.html';
  });
}

/** DPR-aware score trend chart (last 30 points) on a 2D canvas. */
export function drawScoreTrendChart(canvas: HTMLCanvasElement | null, history: any[]): void {
  if (!canvas) return;

  const cssW = Math.max(280, canvas.getBoundingClientRect().width || canvas.width || 1200);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssH = Math.max(190, Math.min(300, Math.round(cssW * 0.3)));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = cssH + 'px';

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cssW;
  const h = cssH;
  ctx.clearRect(0, 0, w, h);

  const list = (history || []).slice(0, 30).slice().reverse();

  if (list.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '500 13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data available', w / 2, h / 2);
    return;
  }

  const padL = 40,
    padR = 40,
    padT = 32,
    padB = 36;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const baseY = padT + chartH;

  const points = list.map((pt: any, i: number) => ({
    x: i,
    score: Number(pt.score) || 0,
    avg: Number(pt.guild_avg_score) || 0,
    label: formatChartDate(pt),
  }));

  let maxVal = 1;
  points.forEach((p) => {
    if (p.score > maxVal) maxVal = p.score;
    if (p.avg > maxVal) maxVal = p.avg;
  });
  maxVal = Math.round(maxVal * 1.25);

  for (let g = 1; g <= 3; g++) {
    const gy = padT + chartH - (chartH * g) / 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, gy + 0.5);
    ctx.lineTo(w - padR, gy + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, baseY + 0.5);
  ctx.lineTo(w - padR, baseY + 0.5);
  ctx.stroke();

  const scoredPoints = points.filter((p) => p.score > 0);
  const avgPoints = points.filter((p) => p.avg > 0);

  if (scoredPoints.length === 0 && avgPoints.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '700 13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No scores recorded in this period', w / 2, padT + chartH / 2 - 6);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '11px Inter, sans-serif';
    ctx.fillText('Scores will appear once submitted and validated', w / 2, padT + chartH / 2 + 14);

    list.forEach((pt: any, i: number) => {
      const x = padL + (chartW * i) / Math.max(1, list.length - 1);
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(formatChartDate(pt), x, baseY + 20);
    });
    return;
  }

  const xFor = (i: number): number => padL + (chartW * i) / Math.max(1, list.length - 1);
  const yFor = (val: number): number => baseY - chartH * (val / maxVal);

  if (avgPoints.length > 0) {
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = '#ffe088';
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    avgPoints.forEach((p, i) => {
      const x = xFor(p.x),
        y = yFor(p.avg);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    avgPoints.forEach((p, idx) => {
      const x = xFor(p.x),
        y = yFor(p.avg);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#1e1f20';
      ctx.fill();
      ctx.strokeStyle = '#ffe088';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (idx === avgPoints.length - 1 || avgPoints.length === 1) {
        const badgeText = 'Avg ' + formatPower(p.avg);
        ctx.font = '700 10px Inter, sans-serif';
        const textWidth = ctx.measureText(badgeText).width;
        const badgeW = textWidth + 14;
        const badgeH = 18;
        const badgeX = Math.min(w - padR - badgeW, x - badgeW / 2);
        let badgeY = y - 22;
        if (badgeY < padT) badgeY = y + 8;

        ctx.fillStyle = '#2c2514';
        ctx.strokeStyle = 'rgba(255, 224, 136, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 9);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffe088';
        ctx.textAlign = 'center';
        ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + 12.5);
      }
    });
  }

  if (scoredPoints.length > 0) {
    const grad = ctx.createLinearGradient(0, padT, 0, baseY);
    grad.addColorStop(0, 'rgba(109,213,140,0.24)');
    grad.addColorStop(1, 'rgba(109,213,140,0.01)');

    ctx.beginPath();
    scoredPoints.forEach((p, i) => {
      const x = xFor(p.x),
        y = yFor(p.score);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (scoredPoints.length > 1) {
      ctx.lineTo(xFor(scoredPoints[scoredPoints.length - 1].x), baseY);
      ctx.lineTo(xFor(scoredPoints[0].x), baseY);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.beginPath();
    scoredPoints.forEach((p, i) => {
      const x = xFor(p.x),
        y = yFor(p.score);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#6dd58c';
    ctx.lineWidth = 3.0;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    scoredPoints.forEach((p) => {
      const x = xFor(p.x),
        y = yFor(p.score);

      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(109,213,140,0.35)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#6dd58c';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.8;
      ctx.stroke();

      const scoreFormatted = formatPower(p.score);
      ctx.font = '800 11px Inter, sans-serif';
      const sWidth = ctx.measureText(scoreFormatted).width;
      const sPillW = sWidth + 10;
      const sPillH = 17;
      const sPillX = x - sPillW / 2;
      let sPillY = y - 22;
      if (sPillY < padT) sPillY = y + 8;

      ctx.fillStyle = 'rgba(17, 17, 20, 0.85)';
      ctx.strokeStyle = 'rgba(109, 213, 140, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(sPillX, sPillY, sPillW, sPillH, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#e3e3e3';
      ctx.textAlign = 'center';
      ctx.fillText(scoreFormatted, x, sPillY + 12);
    });
  }

  list.forEach((pt: any, i: number) => {
    const x = xFor(i);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(formatChartDate(pt), x, baseY + 20);
  });
}
