/**
 * src/modules/events/chest-settings.ts
 *
 * Guild Settings card for the parametrizable SvS / GvG chest-tier grid.
 * Two tabs (SvS / GvG), seven day blocks (day 0 = cumulative prep total,
 * days 1..6 = per-day) with tier rows (min_score -> chests),
 * add/remove per day, and an atomic save backed by EventsService.saveChestTiers.
 * When no grid exists yet in the DB, a sensible default grid is rendered.
 */


import { EventsService, WarEventName } from './events.service';
import { ChestTier } from '../../types/database';
import { getActiveGuild } from '../../core/auth/roles';
import { showToast } from '../app/dialogs/dialogs.service';
import { t, byId, esc } from '../app/admin/utils';
import { defaultChestGrid } from '../../core/scoring/chests';
import { renderBadge } from '../../components/ui/Badge';

/** Grid buckets: day 0 = cumulative "Day 1 to 5 total", 1..6 = per-day. */
const DAYS = [0, 1, 2, 3, 4, 5, 6];

function dayHeader(day: number): string {
  return day === 0 ? t('war_day_total_prep') : t('war_day_n').replace('{day}', String(day));
}

let currentEvent: WarEventName = 'SvS';
let grid: ChestTier[] = [];
let initialized = false;

function dayTiers(day: number): ChestTier[] {
  return grid
    .filter((tier) => tier.day === day)
    .sort((a, b) => a.min_score - b.min_score);
}

function tierIndexBadge(_day: number, idx: number): string {
  return renderBadge({
    text: 'T' + (idx + 1),
    tone: currentEvent === 'SvS' ? 'svs' : 'gvg',
    style: 'soft',
    size: 'sm'
  });
}

function renderGrid(): void {
  const gridEl = byId('chest-tiers-grid');
  if (!gridEl) return;

  gridEl.innerHTML = DAYS.map((day) => {
    const tiers = dayTiers(day);
    const rows = tiers.map((tier, idx) =>
      '<div class="chest-tier-row" data-day="' + day + '">' +
        '<span class="chest-tier-index">' + tierIndexBadge(day, idx) + '</span>' +
        '<input type="number" class="chest-tier-min gm-input gm-input-sm" min="0" step="1" value="' + esc(tier.min_score) + '" placeholder="' + t('war_min_score') + '" aria-label="' + esc(t('war_min_score')) + '">' +
        '<span class="chest-tier-arrow">→</span>' +
        '<input type="number" class="chest-tier-chests gm-input gm-input-sm" min="1" step="1" value="' + esc(tier.chests) + '" placeholder="' + t('war_chests_count') + '" aria-label="' + esc(t('war_chests_count')) + '">' +
        '<button type="button" class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm chest-tier-remove" title="' + t('war_chest_tier_remove') + '" aria-label="' + t('war_chest_tier_remove') + '"><i class="ph ph-trash"></i></button>' +
      '</div>'
    ).join('');

    return '<div class="chest-tier-day">' +
      '<div class="chest-tier-day-header">' + dayHeader(day) + '</div>' +
      (rows || '<div class="chest-tier-empty">' + t('war_tiers_empty_day') + '</div>') +
      '<button type="button" class="gm-btn gm-btn-ghost gm-btn-sm chest-tier-add" data-day="' + day + '">' +
        '<i class="ph ph-plus"></i> <span>' + t('war_chest_tier_add') + '</span>' +
      '</button>' +
    '</div>';
  }).join('');
}

function addTier(day: number): void {
  const gridEl = byId('chest-tiers-grid');
  if (!gridEl) return;

  const tiers = dayTiers(day);
  const row = document.createElement('div');
  row.className = 'chest-tier-row';
  row.setAttribute('data-day', String(day));
  const nextMin = tiers.length > 0 ? Number(tiers[tiers.length - 1].min_score) + 1000 : 1000;
  const nextChests = tiers.length > 0 ? tiers[tiers.length - 1].chests : 1;
  row.innerHTML =
    '<span class="chest-tier-index">' + tierIndexBadge(day, tiers.length) + '</span>' +
    '<input type="number" class="chest-tier-min gm-input gm-input-sm" min="0" step="1" value="' + nextMin + '" placeholder="' + t('war_min_score') + '" aria-label="' + esc(t('war_min_score')) + '">' +
    '<span class="chest-tier-arrow">→</span>' +
    '<input type="number" class="chest-tier-chests gm-input gm-input-sm" min="1" step="1" value="' + nextChests + '" placeholder="' + t('war_chests_count') + '" aria-label="' + esc(t('war_chests_count')) + '">' +
    '<button type="button" class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm chest-tier-remove" title="' + t('war_chest_tier_remove') + '" aria-label="' + t('war_chest_tier_remove') + '"><i class="ph ph-trash"></i></button>';

  const dayBlock = Array.from(gridEl.querySelectorAll('.chest-tier-day'))
    .find((block) => (block.querySelector('.chest-tier-add') as HTMLElement | null)?.getAttribute('data-day') === String(day));
  const empty = dayBlock ? dayBlock.querySelector('.chest-tier-empty') : null;
  if (empty) empty.remove();
  if (dayBlock) {
    const addBtn = dayBlock.querySelector('.chest-tier-add');
    dayBlock.insertBefore(row, addBtn);
  }
}

export async function loadChestTiers(): Promise<void> {
  if (!byId('chest-tiers-grid')) return;

  const activeGuild = getActiveGuild();
  if (!activeGuild) {
    // H2: reading with an unresolved tenant used to read ALPHA's tiers.
    showToast(t('guild_unresolved'), 'error');
    return;
  }
  const result = await EventsService.getChestTiers(activeGuild, currentEvent);
  if (!result.ok) {
    if (result.error && result.error !== 'rpc_failed') {
      showToast(t('war_save_tiers_error') + ' ' + result.error, 'error');
    }
    grid = defaultChestGrid(currentEvent);
  } else {
    grid = result.tiers && result.tiers.length > 0 ? result.tiers : defaultChestGrid(currentEvent);
  }
  renderGrid();
}

function switchEvent(eventName: WarEventName): void {
  currentEvent = eventName;
  document.querySelectorAll('.chest-tiers-tab').forEach((btn) => {
    const evt = btn.getAttribute('data-event');
    btn.classList.toggle('gm-active', evt === eventName);
  });
  void loadChestTiers();
}

async function saveTiers(): Promise<void> {
  const gridEl = byId('chest-tiers-grid');
  const saveBtn = byId<HTMLButtonElement>('chest-tiers-save');
  if (!gridEl) return;
  if (saveBtn) saveBtn.disabled = true;

  const collected: Array<{ day: number; min_score: number; chests: number }> = [];
  const rows = gridEl.querySelectorAll('.chest-tier-row');
  for (const row of Array.from(rows)) {
    const dayRaw = row.getAttribute('data-day');
    if (!dayRaw) continue;
    const day = Number(dayRaw);

    const minEl = row.querySelector<HTMLInputElement>('.chest-tier-min');
    const chestEl = row.querySelector<HTMLInputElement>('.chest-tier-chests');
    const minRaw = minEl ? minEl.value.trim() : '';
    const chestRaw = chestEl ? chestEl.value.trim() : '';

    if (minRaw === '' && chestRaw === '') continue;

    const min = Number(minRaw);
    const chests = Number(chestRaw);
    if (!Number.isInteger(min) || min < 0 || !Number.isInteger(chests) || chests < 1
        || day < 0 || day > 6) {
      showToast(t('war_save_tiers_error'), 'error');
      if (saveBtn) saveBtn.disabled = false;
      return;
    }
    collected.push({ day, min_score: min, chests });
  }

  const normalized: ChestTier[] = [];
  for (const day of DAYS) {
    const dayEntries = collected
      .filter((entry) => entry.day === day)
      .sort((a, b) => a.min_score - b.min_score);
    dayEntries.forEach((entry, idx) => {
      normalized.push({ day, tier: idx + 1, min_score: entry.min_score, chests: entry.chests });
    });
  }

  try {
    const saveGuild = getActiveGuild();
    if (!saveGuild) {
      // H2: worse than a bad read -- this would have WRITTEN ALPHA's tiers.
      showToast(t('guild_unresolved'), 'error');
      return;
    }
    const result = await EventsService.saveChestTiers(saveGuild, currentEvent, normalized);
    if (!result.ok) {
      showToast(t('war_save_tiers_error') + (result.error && result.error !== 'rpc_failed' ? ' ' + result.error : ''), 'error');
    } else {
      showToast(t('war_save_tiers_success'), 'success');
      grid = normalized;
      renderGrid();
    }
  } catch (err: any) {
    showToast(t('war_save_tiers_error') + ' ' + String(err && err.message ? err.message : err), 'error');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

export function initChestTiersSettings(): void {
  if (!byId('chest-tiers-card')) return;
  if (initialized) return;
  initialized = true;

  document.querySelectorAll('.chest-tiers-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const evt = btn.getAttribute('data-event');
      if (evt === 'SvS' || evt === 'GvG') switchEvent(evt);
    });
  });

  const gridEl = byId('chest-tiers-grid');
  if (gridEl) {
    gridEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const addBtn = target.closest<HTMLElement>('.chest-tier-add');
      if (addBtn) {
        const day = Number(addBtn.getAttribute('data-day'));
        if (day >= 0 && day <= 6) addTier(day);
        return;
      }
      const rmBtn = target.closest<HTMLElement>('.chest-tier-remove');
      if (rmBtn) {
        const row = rmBtn.closest<HTMLElement>('.chest-tier-row');
        if (row) row.remove();
      }
    });
  }

  const saveBtn = byId<HTMLButtonElement>('chest-tiers-save');
  if (saveBtn) saveBtn.addEventListener('click', () => { void saveTiers(); });

  switchEvent(currentEvent);
}