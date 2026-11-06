/**
 * src/modules/app/season/season.ts
 *
 * Season 2 (owner decisions, 2026-11-06):
 *   - every signed-in user, admin or player, sees a notice on every visit
 *     while the app is in season 1 (`showSeasonNoticeIfDue`);
 *   - only the super admin can start Season 2, from a card of the super-admin
 *     tab (`renderSeasonCard`), which deletes every guild's recorded data and
 *     keeps the players and their military stats (gm_start_season_2).
 *
 * The season is read from the database (gm_season_status), not from the
 * browser, so the notice disappears for everyone the moment Season 2 starts.
 */
import { getClient } from '../../../core/api/supabase';
import { isSuperAdmin } from '../../../core/auth/roles';
import { escapeHTML } from '../../../core/utils/text';
import { t } from '../../../core/i18n/i18n';
import { openDialog, closeDialog } from '../../../components/ui/Dialog';
import { showToast } from '../dialogs/dialogs.service';

/** The phrase the super admin must type: the function refuses anything else. */
export const SEASON_2_CONFIRM_PHRASE = 'START SEASON 2';

/** The current season, or null when it cannot be read (the notice then stays hidden). */
export async function fetchSeason(): Promise<number | null> {
  const db = getClient();
  if (!db) return null;
  try {
    const { data, error } = await db.rpc('gm_season_status');
    if (error || !data || typeof data !== 'object') return null;
    const season = Number((data as { season?: unknown }).season);
    return Number.isInteger(season) ? season : null;
  } catch {
    return null;
  }
}

let noticeShownThisVisit = false;

/** Shows the Season 2 notice once per visit while the app is in season 1. Never throws. */
export async function showSeasonNoticeIfDue(): Promise<boolean> {
  if (noticeShownThisVisit || typeof document === 'undefined') return false;
  const season = await fetchSeason();
  if (season !== 1 || noticeShownThisVisit) return false;
  noticeShownThisVisit = true;
  openDialog({
    id: 'season-2-notice',
    title: t('season2_notice_title'),
    iconClass: 'ph-hourglass-medium',
    size: 'sm',
    body: '<p class="gm-ui-dialog-message">' + escapeHTML(t('season2_notice_body')) + '</p>',
    footer:
      '<button type="button" id="season-2-notice-ok" class="gm-btn gm-btn-primary" data-dialog-close>' +
      escapeHTML(t('season2_notice_ok')) +
      '</button>',
  });
  return true;
}

/** For tests: forget that the notice was shown. */
export function resetSeasonNoticeForTests(): void {
  noticeShownThisVisit = false;
}

export interface SeasonStartResult {
  ok: boolean;
  error?: string;
  deleted?: Record<string, number>;
}

/** Calls gm_start_season_2; the database checks the role and the phrase again. */
export async function startSeason2(confirmPhrase: string): Promise<SeasonStartResult> {
  const db = getClient();
  if (!db) return { ok: false, error: 'no_client' };
  const { data, error } = await db.rpc('gm_start_season_2', { p_confirm: confirmPhrase });
  if (error) return { ok: false, error: error.message || error.code || 'db_error' };
  const res = (data || {}) as SeasonStartResult;
  return res.ok === true ? res : { ok: false, error: res.error || 'failed' };
}

/** Fills #season-card in the super-admin tab. Hidden for everyone else, and once Season 2 has started. */
export async function renderSeasonCard(): Promise<void> {
  const card = document.getElementById('season-card');
  if (!card) return;
  if (!isSuperAdmin()) {
    card.classList.add('hidden');
    return;
  }
  const season = await fetchSeason();
  card.classList.remove('hidden');
  const body = card.querySelector('#season-card-body');
  if (!body) return;
  if (season === null) {
    body.innerHTML = '<p class="u-c-text-muted u-fs-0_85rem">' + escapeHTML(t('season2_status_unknown')) + '</p>';
    return;
  }
  if (season >= 2) {
    body.innerHTML = '<p class="u-c-text-muted u-fs-0_85rem">' + escapeHTML(t('season2_already_started')) + '</p>';
    return;
  }
  body.innerHTML =
    '<p class="u-c-text-muted u-fs-0_85rem u-m-0-0-1rem">' +
    escapeHTML(t('season2_card_body')) +
    '</p>' +
    '<button type="button" id="season-2-start-btn" class="gm-btn gm-btn-danger">' +
    '<i class="ph ph-flag-checkered"></i> <span>' +
    escapeHTML(t('season2_start_btn')) +
    '</span></button>';
  body.querySelector('#season-2-start-btn')?.addEventListener('click', () => openSeasonStartDialog());
}

function openSeasonStartDialog(): void {
  const dialog = openDialog({
    id: 'season-2-start',
    title: t('season2_start_title'),
    iconClass: 'ph-warning',
    tone: 'danger',
    size: 'md',
    body:
      '<p class="gm-ui-dialog-message">' +
      escapeHTML(t('season2_start_deleted')) +
      '</p><p class="gm-ui-dialog-message">' +
      escapeHTML(t('season2_start_kept')) +
      '</p><label for="season-2-confirm-input" class="u-fs-0_8rem gm-dim">' +
      escapeHTML(t('season2_start_type')) +
      ' <strong>' +
      escapeHTML(SEASON_2_CONFIRM_PHRASE) +
      '</strong></label>' +
      '<input type="text" id="season-2-confirm-input" name="season-2-confirm" class="gm-input" autocomplete="off" spellcheck="false">',
    noFooter: false,
    footer:
      '<button type="button" class="gm-btn gm-btn-ghost" data-dialog-close>' +
      escapeHTML(t('confirm_cancel')) +
      '</button>' +
      '<button type="button" id="season-2-confirm-btn" class="gm-btn gm-btn-danger" disabled>' +
      escapeHTML(t('season2_start_btn')) +
      '</button>',
  });

  const input = dialog.querySelector<HTMLInputElement>('#season-2-confirm-input');
  const confirmBtn = dialog.querySelector<HTMLButtonElement>('#season-2-confirm-btn');
  if (!input || !confirmBtn) return;
  input.addEventListener('input', () => {
    confirmBtn.disabled = input.value.trim() !== SEASON_2_CONFIRM_PHRASE;
  });
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const res = await startSeason2(input.value.trim());
    if (!res.ok) {
      showToast(t('season2_start_failed') + ' ' + (res.error || ''), 'error');
      confirmBtn.disabled = false;
      return;
    }
    const total = Object.values(res.deleted || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    showToast(t('season2_started_toast').replace('{n}', String(total)), 'success');
    closeDialog(dialog);
    await renderSeasonCard();
  });
}
