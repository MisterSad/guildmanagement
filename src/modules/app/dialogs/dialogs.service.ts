/**
 * src/modules/app/dialogs/dialogs.service.ts
 *
 * Sous-lot 6.1 (Strangler) — Global modal/toast layer ported from `app.js`:
 *   - showConfirm()             (legacy `window.showConfirm`)
 *   - showPlayerHistoryDialog() (legacy `window.GM_APP.showPlayerHistory`)
 *   - openCustomMsgModal()      (legacy `data-custom-msg` click handler)
 *   - showToast()               (legacy `window.GM_APP.showToast`)
 *
 * The legacy `app.js` is intentionally left in place for this lot; `src/main.ts`
 * overwrites the parse-time bridges with these typed implementations. All
 * `window.GM` reads (escapeHTML / t / db / config) happen at call time so that
 * test stubs and the classic-script → deferred-module load order keep working.
 *
 * This module never assigns any `window.GM_*` variable (bridge lives in main.ts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { renderToast } from '../../../core/dom/toast';

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function gm(): any {
  return winAny().GM;
}

function t(key: string): string {
  const w = winAny();
  const dict = w.GM_I18N;
  if (dict && typeof dict.t === 'function') return dict.t(key);
  const g = gm();
  return g && typeof g.t === 'function' ? g.t(key) : key;
}

function esc(value: unknown): string {
  const g = gm();
  if (g && typeof g.escapeHTML === 'function') return g.escapeHTML(value);
  return value === null || value === undefined ? '' : String(value);
}

function getDb(): any {
  const g = gm();
  return g && g.db ? g.db : null;
}

async function configGet(key: string): Promise<string> {
  const g = gm();
  if (g && g.config && typeof g.config.get === 'function') {
    const value = await g.config.get(key);
    return value === null || value === undefined ? '' : String(value);
  }
  return '';
}

async function configSet(key: string, value: string): Promise<void> {
  const g = gm();
  if (g && g.config && typeof g.config.set === 'function') {
    await g.config.set(key, value);
    return;
  }
  throw new Error('config_unavailable');
}

/**
 * Concrete toast renderer exposed as `window.GM_APP.showToast`. Deliberately
 * does NOT go through `core/dom/toast.showToast` (which delegates back to
 * `GM_APP.showToast` and would recurse); it calls the non-delegating renderer.
 */
export function showToast(message: unknown, type?: string): void {
  renderToast(message, type, 3500);
}

/**
 * Global confirmation modal. `message` is trusted HTML by contract (every
 * legacy caller passes markup such as `'<strong>…</strong>'`); `title` is
 * always escaped. `onCancel` is invoked on cancel/Escape/overlay dismissal.
 */
export function showConfirm(
  title: string,
  message: string,
  onConfirm: () => void,
  onCancel?: () => void
): void {
  if (typeof document === 'undefined') return;

  const existing = document.getElementById('confirm-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'confirm-overlay';
  overlay.className = 'gm-modal-overlay';
  overlay.innerHTML =
    '<div class="gm-modal-card" style="max-width: 400px; width: 90%; text-align: center;">' +
      '<div class="confirm-icon"><i class="ph-fill ph-warning text-error"></i></div>' +
      '<h3>' + esc(title) + '</h3>' +
      '<p>' + message + '</p>' +
      '<div class="confirm-actions">' +
        '<button id="confirm-cancel" class="gm-btn gm-btn-ghost">' + t('confirm_cancel') + '</button>' +
        '<button id="confirm-ok" class="gm-btn gm-btn-danger">' + t('confirm_ok') + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => { overlay.classList.add('visible'); });

  let settled = false;
  function close(confirmed: boolean): void {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKeydown);
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.remove(); }, 300);
    if (confirmed) onConfirm();
    else if (onCancel) onCancel();
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') close(false);
  }

  const cancelBtn = document.getElementById('confirm-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => close(false));
  const okBtn = document.getElementById('confirm-ok');
  if (okBtn) okBtn.addEventListener('click', () => close(true));
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(false); });
  document.addEventListener('keydown', onKeydown);
}

interface PlayerMetricsRow {
  total_power?: number;
  week_start?: string;
}

/** Player history modal (power trend + per-event attendance). */
export async function showPlayerHistoryDialog(uid: string, pseudo: string): Promise<void> {
  if (typeof document === 'undefined') return;

  const existing = document.getElementById('player-history-overlay');
  if (existing) existing.remove();

  const html =
    '<div id="player-history-overlay" class="gm-modal-overlay">' +
      '<div class="gm-modal-card" style="max-width: 640px; width: 92%; position: relative;">' +
        '<div class="gm-modal-header" style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 1rem;">' +
          '<div style="display:flex; align-items:center; gap:0.5rem;">' +
            '<i class="ph ph-chart-line-up" style="font-size: var(--fs-3xl); color: var(--accent);"></i>' +
            '<h3 style="margin:0; font-size: var(--fs-xl);">' + esc(pseudo) + ' — Player History</h3>' +
          '</div>' +
          '<button type="button" class="gm-mini-btn gm-close-modal"><i class="ph ph-x"></i></button>' +
        '</div>' +
        '<div class="gm-modal-body" id="player-history-body" style="display:flex; flex-direction:column; gap:1.25rem; max-height:70vh; overflow-y:auto;">' +
          '<div class="gm-empty" style="padding:2rem;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading history...</div></div>' +
        '</div>' +
        '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top: 1.5rem;">' +
          '<button type="button" class="gm-btn gm-btn-ghost gm-close-modal">Close</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = document.getElementById('player-history-overlay');
  if (!overlay) return;
  requestAnimationFrame(() => { overlay.classList.add('visible'); });

  const closeModal = (): void => {
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.remove(); }, 200);
  };
  overlay.querySelectorAll('.gm-close-modal').forEach((btn) => { btn.addEventListener('click', closeModal); });
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeModal(); });

  const body = document.getElementById('player-history-body');
  if (!body) return;
  if (!uid) {
    body.innerHTML = '<div class="gm-empty" style="padding:2rem;"><div class="gm-empty-title">No UID on file for this player.</div></div>';
    return;
  }

  const db = getDb();
  if (!db) {
    body.innerHTML = '<div class="gm-empty" style="padding:2rem;"><div class="gm-empty-title">Failed to load player history.</div></div>';
    return;
  }

  try {
    const [metricsRes, eventRes] = await Promise.all([
      db.rpc('gm_get_player_metrics_history', { p_uid: uid, p_limit: 12 }),
      db.rpc('gm_get_player_event_history', { p_uid: uid, p_limit: 60 })
    ]);

    const metrics = metricsRes && metricsRes.data && metricsRes.data.ok ? metricsRes.data : null;
    const eventData = eventRes && eventRes.data && eventRes.data.ok ? eventRes.data : null;
    const powerHistory: PlayerMetricsRow[] =
      metrics && Array.isArray(metrics.history) ? metrics.history : [];

    let sections = '';

    if (powerHistory.length > 0) {
      sections += '<div>' +
        '<h4 style="margin:0 0 .5rem; font-size: var(--fs-md); color:var(--fg-dim); font-weight:600;">Power trend (last ' + powerHistory.length + ' weeks)</h4>' +
        '<canvas id="player-history-power-canvas" style="width:100%; display:block;"></canvas>' +
      '</div>';
    }

    const events: Record<string, any> =
      eventData && eventData.events && typeof eventData.events === 'object' ? eventData.events : {};
    const eventKeys = Object.keys(events);
    if (eventKeys.length > 0) {
      sections += '<div>' +
        '<h4 style="margin:0 0 .5rem; font-size: var(--fs-md); color:var(--fg-dim); font-weight:600;">Event participation</h4>' +
        '<div style="display:flex; flex-direction:column; gap:.5rem;">' +
          eventKeys.sort().map((evKey) => {
            const ev = events[evKey] || {};
            const rateColor = ev.rate >= 80 ? '#34d399' : (ev.rate >= 50 ? '#fbbf24' : 'var(--fg-dim)');
            return '<div style="display:flex; align-items:center; justify-content:space-between; padding:.6rem .8rem; background:rgba(255,255,255,0.03); border-radius:8px; border:1px solid rgba(255,255,255,0.06);">' +
              '<span style="font-weight:600;">' + esc(evKey) + '</span>' +
              '<span style="font-size: var(--fs-base); color:' + rateColor + '; font-weight:700;">' + ev.attended + '/' + ev.count + ' attended (' + ev.rate + '%)</span>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
    }

    if (!sections) {
      body.innerHTML = '<div class="gm-empty" style="padding:2rem;"><div class="gm-empty-title">No history available for this player.</div></div>';
      return;
    }

    body.innerHTML = sections;

    const g = gm();
    if (powerHistory.length > 0 && g && typeof g.drawScoreTrendChart === 'function') {
      const canvas = document.getElementById('player-history-power-canvas') as HTMLCanvasElement | null;
      if (canvas) {
        const chartHistory = powerHistory.map((h) => ({
          score: h.total_power,
          guild_avg_score: 0,
          week_start: h.week_start
        }));
        g.drawScoreTrendChart(canvas, chartHistory);
      }
    }
  } catch (err) {
    console.error('Failed to load player history', err);
    body.innerHTML = '<div class="gm-empty" style="padding:2rem;"><div class="gm-empty-title">Failed to load player history.</div></div>';
  }
}

interface ReminderDef {
  key: string;
  label: string;
}

const REMINDERS_BY_PREFIX: Record<string, ReminderDef[]> = {
  armsrace: [
    { key: 'reminder_30', label: '30 Minutes Reminder' },
    { key: 'reminder_5', label: '5 Minutes Reminder' },
    { key: 'start', label: 'Event Start' }
  ],
  dtr: [
    { key: 'reminder_30', label: '30 Minutes Reminder' },
    { key: 'reminder_5', label: '5 Minutes Reminder' },
    { key: 'start', label: 'Event Start' }
  ],
  shadowfront: [
    { key: 'reminder_30', label: '30 Minutes Reminder' },
    { key: 'reminder_5', label: '5 Minutes Reminder' },
    { key: 'start', label: 'Event Start' }
  ],
  calamity: [
    { key: 'reminder_10', label: '10 Minutes Reminder' }
  ],
  gvg: [
    { key: 'reminder', label: '5 Minutes Reminder' },
    { key: 'start', label: 'Event Start' }
  ],
  svs: [
    { key: 'reminder_30_invasion', label: '30 Min Reminder (Invasion)' },
    { key: 'reminder_30_defense', label: '30 Min Reminder (Defense)' },
    { key: 'reminder_5_invasion', label: '5 Min Reminder (Invasion)' },
    { key: 'reminder_5_defense', label: '5 Min Reminder (Defense)' },
    { key: 'start_invasion', label: 'Event Start (Invasion)' },
    { key: 'start_defense', label: 'Event Start (Defense)' },
    { key: 'garrison', label: 'Garrison Reminder' }
  ]
};

const TITLE_MAP: Record<string, string> = {
  armsrace: 'Arms Race',
  dtr: 'Defend Trade Route',
  shadowfront: 'Shadowfront',
  calamity: 'Calamity Befalls',
  gvg: 'GvG Saturday',
  svs: 'SvS PvP'
};

/** Default Discord templates, mirroring app.js#openCustomMsgModal. */
function getDefaultTpl(eventPrefix: string, key: string, field: string): string {
  if (eventPrefix === 'armsrace' || eventPrefix === 'dtr' || eventPrefix === 'shadowfront') {
    const namePlaceholder = '{event_name}';
    if (key === 'reminder_30') {
      if (field === 'content') return '⏰ **Reminder:** ' + namePlaceholder + ' starts in **30 minutes**! {guild_tag}';
      if (field === 'title') return '⏰ Reminder: ' + namePlaceholder + ' starts in 30 minutes!';
      if (field === 'desc') return 'Get ready, soldiers! Please log in and prepare for the event.';
    } else if (key === 'reminder_5') {
      if (field === 'content') return '🚨 **Immediate Reminder:** ' + namePlaceholder + ' starts in **5 minutes**! Get ready! {guild_tag}';
      if (field === 'title') return '🚨 Immediate Reminder: ' + namePlaceholder + ' starts in 5 minutes!';
      if (field === 'desc') return 'Action time! Join your squad now!';
    } else if (key === 'start') {
      if (field === 'content') return '⚔️ **Event Started:** ' + namePlaceholder + ' starts now! {guild_tag}';
      if (field === 'title') return '⚔️ Event Started: ' + namePlaceholder + ' is active!';
      if (field === 'desc') return 'Action time! Join your squad now!';
    }
  } else if (eventPrefix === 'calamity') {
    if (field === 'content') return '⏰ **Calamity Befalls: Round {round} starts in 10 minutes!**';
    if (field === 'title') return '⏰ Calamity Befalls - Round {round} (Reminder)';
    if (field === 'desc') return 'Prepare your squads! Calamity Befalls Round {round} starts in 10 minutes.';
  } else if (eventPrefix === 'gvg') {
    if (key === 'reminder') {
      if (field === 'content') return '⏰ **GvG: {event_name}** starts in **5 minutes**! @everyone';
      if (field === 'title') return '⏰ GvG - {event_name} (Reminder)';
      if (field === 'desc') return 'Get ready! The {event_name} event starts in 5 minutes.';
    } else if (key === 'start') {
      if (field === 'content') return '⚔️ **GvG: {event_name}** starts now! @everyone';
      if (field === 'title') return '⚔️ GvG - {event_name}';
      if (field === 'desc') return 'The {event_name} event is active. Join the battle now!';
    }
  } else if (eventPrefix === 'svs') {
    if (key === 'reminder_30_invasion') {
      if (field === 'content') return '⏰ **SvS: Invasion starts in 30 minutes! Prepare to attack!** @everyone';
      if (field === 'title') return '⏰ SvS: Invasion starts in 30 minutes';
      if (field === 'desc') return 'We won the preparation! We are invading the enemy server...';
    } else if (key === 'reminder_30_defense') {
      if (field === 'content') return '⏰ **SvS: Defense starts in 30 minutes! Protect yourself!** @everyone';
      if (field === 'title') return '⏰ SvS: Defense starts in 30 minutes';
      if (field === 'desc') return 'We are being invaded. Please put all your ships in garrison now...';
    } else if (key === 'reminder_5_invasion') {
      if (field === 'content') return '🚨 **SvS: Invasion starts in 5 minutes! Join attack squads!** @everyone';
      if (field === 'title') return '🚨 SvS: Invasion starts in 5 minutes!';
      if (field === 'desc') return 'Portal opens in 5 minutes! Ready to jump and attack...';
    } else if (key === 'reminder_5_defense') {
      if (field === 'content') return '🚨 **SvS: Defense starts in 5 minutes! Ready your squads!** @everyone';
      if (field === 'title') return '🚨 SvS: Defense starts in 5 minutes!';
      if (field === 'desc') return 'Invasion is imminent. Make sure your home assets are safe...';
    } else if (key === 'start_invasion') {
      if (field === 'content') return '⚔️ **SvS: Invasion has started! Go attack!** @everyone';
      if (field === 'title') return '⚔️ SvS: Invasion has started!';
      if (field === 'desc') return 'The invasion portal is open! Jump to the enemy server...';
    } else if (key === 'start_defense') {
      if (field === 'content') return '⚔️ **SvS: Blackhole Defense has started! Protect the server!** @everyone';
      if (field === 'title') return '⚔️ SvS: Defense has started!';
      if (field === 'desc') return 'Enemy forces are entering our server! Defend the Blackhole at all costs...';
    } else if (key === 'garrison') {
      if (field === 'content') return '🛡️ **SvS: Garrison Reminder** - Don\'t forget to put your ships in garrison! @everyone';
      if (field === 'title') return '🛡️ SvS: Garrison Reminder';
      if (field === 'desc') return 'Put your ships in garrison to avoid being attacked while offline.';
    }
  }
  return '';
}

/** Discord message personalization modal (legacy `[data-custom-msg]` handler). */
export async function openCustomMsgModal(eventPrefix: string): Promise<void> {
  if (typeof document === 'undefined') return;

  const existing = document.getElementById('custom-msg-modal');
  if (existing) existing.remove();

  const reminders = REMINDERS_BY_PREFIX[eventPrefix] || [];
  const templates: Record<string, string> = {};
  for (const reminder of reminders) {
    templates[reminder.key + '_content'] = await configGet('tpl_' + eventPrefix + '_' + reminder.key + '_content') || '';
    templates[reminder.key + '_title'] = await configGet('tpl_' + eventPrefix + '_' + reminder.key + '_title') || '';
    templates[reminder.key + '_desc'] = await configGet('tpl_' + eventPrefix + '_' + reminder.key + '_desc') || '';
  }

  const overlay = document.createElement('div');
  overlay.id = 'custom-msg-modal';
  overlay.className = 'gm-modal-overlay';

  let html =
    '<div class="gm-profile-card" style="max-width: 600px; gap: 1.25rem; align-items: stretch; text-align: left;">' +
      '<div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-soft); padding-bottom: 0.75rem;">' +
        '<h3 style="font-family: var(--font-display); font-size: var(--fs-xl); margin: 0; display: flex; align-items: center; gap: 0.5rem; color: var(--fg);">' +
          '<i class="ph ph-note-pencil" style="color: var(--accent);"></i> Personalization - ' + (TITLE_MAP[eventPrefix] || eventPrefix) +
        '</h3>' +
        '<button type="button" class="gm-btn gm-btn-ghost gm-btn-icon" id="custom-msg-modal-close" style="padding: 0.25rem;"><i class="ph ph-x"></i></button>' +
      '</div>' +
      '<div style="font-size: var(--fs-sm); color: var(--fg-dim); background: rgba(99, 102, 241, 0.08); border: 1px solid rgba(99, 102, 241, 0.15); border-radius: 6px; padding: 0.65rem 0.8rem; line-height: 1.4;">' +
        '<strong>Available variables:</strong> <code>{event_name}</code>, <code>{date}</code>, <code>{guild_tag}</code>' +
        (eventPrefix === 'calamity' ? ', <code>{round}</code>' : '') +
        '<br><span style="font-size: var(--fs-sm);">Leave blank to use the default message template.</span>' +
      '</div>' +
      '<div style="display: flex; flex-direction: column; gap: 1.5rem; max-height: 50vh; overflow-y: auto; padding-right: 0.25rem;">';

  for (const reminder of reminders) {
    const defContent = getDefaultTpl(eventPrefix, reminder.key, 'content');
    const defTitle = getDefaultTpl(eventPrefix, reminder.key, 'title');
    const defDesc = getDefaultTpl(eventPrefix, reminder.key, 'desc');

    const valContent = templates[reminder.key + '_content'] || '';
    const valTitle = templates[reminder.key + '_title'] || '';
    const valDesc = templates[reminder.key + '_desc'] || '';

    html +=
      '<div style="display: flex; flex-direction: column; gap: 0.75rem; border-bottom: 1px dashed var(--border-soft); padding-bottom: 1.25rem;">' +
        '<div style="font-size: var(--fs-base); font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: 0.04em;">' + reminder.label + '</div>' +
        '<div class="gm-col" style="gap: 0.35rem;">' +
          '<label style="font-size: var(--fs-sm); color: var(--fg-dim);">Discord Message (ping / main text):</label>' +
          '<input type="text" id="tpl-' + reminder.key + '-content" class="gm-input gm-input-sm" style="font-size: var(--fs-sm);" placeholder="' + esc(defContent) + '" value="' + esc(valContent) + '">' +
        '</div>' +
        '<div class="gm-col" style="gap: 0.35rem;">' +
          '<label style="font-size: var(--fs-sm); color: var(--fg-dim);">Embed Title:</label>' +
          '<input type="text" id="tpl-' + reminder.key + '-title" class="gm-input gm-input-sm" style="font-size: var(--fs-sm);" placeholder="' + esc(defTitle) + '" value="' + esc(valTitle) + '">' +
        '</div>' +
        '<div class="gm-col" style="gap: 0.35rem;">' +
          '<label style="font-size: var(--fs-sm); color: var(--fg-dim);">Embed Description:</label>' +
          '<textarea id="tpl-' + reminder.key + '-desc" class="gm-input" style="font-size: var(--fs-sm); height: 60px; resize: vertical;" placeholder="' + esc(defDesc) + '">' + valDesc + '</textarea>' +
        '</div>' +
      '</div>';
  }

  html +=
      '</div>' +
      '<div style="display: flex; gap: 0.75rem; justify-content: flex-end; border-top: 1px solid var(--border-soft); padding-top: 0.75rem;">' +
        '<button type="button" class="gm-btn gm-btn-ghost" id="custom-msg-modal-cancel">Cancel</button>' +
        '<button type="button" class="gm-btn gm-btn-primary" id="custom-msg-modal-save">' +
          '<i class="ph ph-check"></i> Save' +
        '</button>' +
      '</div>' +
    '</div>';

  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  requestAnimationFrame(() => { overlay.classList.add('visible'); });

  function closeModal(): void {
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.remove(); }, 250);
  }

  const closeBtn = document.getElementById('custom-msg-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  const cancelBtn = document.getElementById('custom-msg-modal-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeModal(); });

  const saveBtn = document.getElementById('custom-msg-modal-save') as HTMLButtonElement | null;
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      const origText = saveBtn.innerHTML;
      saveBtn.textContent = '...';

      try {
        const promises: Promise<void>[] = [];
        for (const reminder of reminders) {
          const contentEl = document.getElementById('tpl-' + reminder.key + '-content') as HTMLInputElement | null;
          const titleEl = document.getElementById('tpl-' + reminder.key + '-title') as HTMLInputElement | null;
          const descEl = document.getElementById('tpl-' + reminder.key + '-desc') as HTMLTextAreaElement | null;

          promises.push(configSet('tpl_' + eventPrefix + '_' + reminder.key + '_content', contentEl ? contentEl.value.trim() : ''));
          promises.push(configSet('tpl_' + eventPrefix + '_' + reminder.key + '_title', titleEl ? titleEl.value.trim() : ''));
          promises.push(configSet('tpl_' + eventPrefix + '_' + reminder.key + '_desc', descEl ? descEl.value.trim() : ''));
        }
        await Promise.all(promises);
        showToast(t('toast_config_updated'), 'success');
        closeModal();
      } catch (err) {
        showToast(t('toast_err_generic') + ' ' + (err instanceof Error ? err.message : String(err)), 'error');
        saveBtn.disabled = false;
        saveBtn.innerHTML = origText;
      }
    });
  }
}
