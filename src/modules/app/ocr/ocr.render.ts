/**
 * src/modules/app/ocr/ocr.render.ts
 *
 * Sous-lot 6.7 (Strangler) — OCR results table rendering ported from app.js:
 * renderOcrResults (event + roster/metric modes), renderOcrRankCell,
 * toggleAllCheckboxes and updateCommitButtonCount. Every extracted value is
 * escaped via esc().
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { esc, byId, winAny } from '../admin/utils';
import { getGuildMembers } from '../members/members.store';
import { categorizeOcrDiff, computeOcrRosterDelta } from '../../ocr/ocr.service';
import {
  OCR_METRICS_META,
  getCurrentOcrMetric,
  getOcrMeta,
  getOcrExtractedPlayers
} from './ocr.meta';

function gm(): any {
  return winAny().GM;
}
function fmtNum(value: unknown): string {
  const x = gm();
  return x && typeof x.formatNumber === 'function' ? x.formatNumber(value) : String(value ?? 0);
}
function findBestMatchingMember(pseudo: string, members: any[], tag: string | null): any {
  const x = gm();
  return x && typeof x.findBestMatchingMember === 'function' ? x.findBestMatchingMember(pseudo, members, tag) : null;
}
function cleanPlayerPseudo(pseudo: string, tag: string | null): string {
  const x = gm();
  return x && typeof x.cleanPlayerPseudo === 'function' ? x.cleanPlayerPseudo(pseudo, tag) : String(pseudo).trim();
}
function activeTag(): string {
  const input = byId<HTMLInputElement>('ocr-guild-tag-input');
  return input && input.value.trim() ? input.value.trim() : '';
}

export function renderOcrRankCell(idx: number, detectedRank: string | null | undefined, currentRole?: string | null): string {
  if (currentRole === 'R5') {
    return '<td class="ocr-cell-rank"><span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3); font-size: var(--fs-xs); white-space:nowrap;" title="R5 Leader is protected from bulk rank changes"><i class="ph ph-shield-star"></i> R5</span></td>';
  }
  const noChangeLabel = currentRole ? ('Keep (' + currentRole + ')') : 'R1 (default)';
  let opts = '<option value="">' + esc(noChangeLabel) + '</option>';
  ['R4', 'R3', 'R2', 'R1'].forEach((r) => {
    opts += '<option value="' + r + '"' + (detectedRank === r ? ' selected' : '') + '>' + r + '</option>';
  });
  return '<td class="ocr-cell-rank"><select class="ocr-edit-rank gm-input" data-index="' + idx + '" style="padding:0.2rem 0.35rem; font-size: var(--fs-sm); font-weight:600; width:100%; max-width:118px;">' + opts + '</select></td>';
}

export function renderOcrResults(players: any[]): void {
  const loading = byId('ocr-loading');
  const resultsContainer = byId('ocr-results-container');
  const table = resultsContainer ? resultsContainer.querySelector('.ocr-table') : null;
  const tbody = byId('ocr-results-tbody');
  const tbodyNew = byId('ocr-results-tbody-new');
  const tbodyRemoved = byId('ocr-results-tbody-removed');
  const countSpan = byId('ocr-detected-count');
  const summaryBadges = byId('ocr-summary-badges');
  const btnCommit = byId('ocr-commit-btn');

  const meta = getOcrMeta();
  const targetField = meta.field;
  const isMultiGuild = !!meta.isMultiGuild;

  if (loading) loading.style.display = 'none';
  if (resultsContainer) resultsContainer.style.display = 'block';
  if (btnCommit) btnCommit.style.display = 'inline-flex';
  if (countSpan) countSpan.textContent = String(players ? players.length : 0);

  const members = getGuildMembers();

  if (!players || players.length === 0) {
    if (tbody) {
      const cs = meta.isEvent ? 4 : 5;
      tbody.innerHTML = '<tr><td colspan="' + cs + '" style="text-align:center; padding:2rem; color:var(--text-muted);"><i class="ph ph-warning-circle" style="font-size: var(--fs-3xl); display:block; margin-bottom:0.5rem; color:#facc15;"></i>No player usernames or ' + esc(meta.header) + ' values were detected in the uploaded image(s). Please try clearer screenshots.</td></tr>';
    }
    if (tbodyNew) tbodyNew.innerHTML = '';
    if (tbodyRemoved) tbodyRemoved.innerHTML = '';
    if (summaryBadges) summaryBadges.innerHTML = '<span class="gm-chip" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);"><i class="ph ph-x-circle"></i> 0 Detected</span>';
    updateCommitButtonCount();
    return;
  }

  if (meta.isEvent) {
    if (table) { table.classList.add('ocr-table--event'); table.classList.remove('ocr-table--roster'); }
    if (tbodyNew) tbodyNew.innerHTML = '';
    if (tbodyRemoved) tbodyRemoved.innerHTML = '';

    let updateCount = 0, reconciledCount = 0, otherGuildCount = 0;
    let sfAssignments: any[] = [];
    const sf = winAny().GM_SHADOWFRONT;
    if (meta.eventType === 'shadowfront' && sf && typeof sf.getAssignments === 'function') sfAssignments = sf.getAssignments();

    let html = '';
    players.forEach((p, idx) => {
      const matchRes = findBestMatchingMember(p.pseudo, members, activeTag());
      const existing = matchRes ? matchRes.member : null;
      const matchType = matchRes ? matchRes.matchType : null;
      const cleanPseudo = cleanPlayerPseudo(p.pseudo, activeTag());
      let effectivePseudo = existing ? existing.pseudo : cleanPseudo;
      if (existing && (matchType === 'normalized' || matchType === 'fuzzy' || matchType === 'clean_tag') && p.pseudo !== existing.pseudo) {
        effectivePseudo = existing.pseudo; p.pseudo = existing.pseudo; reconciledCount++;
      }
      const pScore = p.score != null ? p.score : (p.overall_power || 0);
      let badgeHtml = '';
      let isChecked = true;

      if (!existing) {
        otherGuildCount++; isChecked = false;
        badgeHtml = '<span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-slash"></i> Other Guild / Non-Member</span>';
      } else if (meta.eventType === 'shadowfront') {
        updateCount++;
        const a = sfAssignments.find((x) => x.pseudo && x.pseudo.toLowerCase() === existing.pseudo.toLowerCase());
        if (a && a.role === 'reserve') badgeHtml = '<span class="gm-chip" style="background:rgba(168,85,247,0.15); color:#c084fc; border:1px solid rgba(168,85,247,0.3);"><i class="ph ph-clock-countdown"></i> Substitute &rarr; [Sub Present ✓] + [Participated ✓]</span>';
        else if (a && a.role === 'participant') badgeHtml = '<span class="gm-chip gm-chip-success"><i class="ph ph-shield-check"></i> Main Squad &rarr; [Participated ✓]</span>';
        else badgeHtml = '<span class="gm-chip gm-chip-warning"><i class="ph ph-warning"></i> Guild Member &rarr; [Participated ✓]</span>';
      } else if (getCurrentOcrMetric() === 'dtr') {
        updateCount++;
        badgeHtml = pScore > 0
          ? '<span class="gm-chip gm-chip-success"><i class="ph ph-check-circle"></i> Score: ' + fmtNum(pScore) + ' &rarr; [Participated ✓]</span>'
          : '<span class="gm-chip gm-chip-accent"><i class="ph ph-check-square"></i> Score: 0 &rarr; [Appointed ✓] + [Participated ✓]</span>';
      } else if (meta.eventType === 'armsrace') {
        updateCount++;
        badgeHtml = '<span class="gm-chip gm-chip-success"><i class="ph ph-check-circle"></i> Present &rarr; [Participated ✓]</span>';
      } else if (getCurrentOcrMetric() === 'svs_prep' || getCurrentOcrMetric() === 'gvg_prep'
           || getCurrentOcrMetric() === 'svs_day' || getCurrentOcrMetric() === 'gvg_day') {
        updateCount++;
        badgeHtml = '<span class="gm-chip" style="background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3);"><i class="ph ph-sword"></i> Prep Score: ' + fmtNum(pScore) + ' &rarr; [Participated ✓]</span>';
      } else if (getCurrentOcrMetric() === 'svs_pvp' || getCurrentOcrMetric() === 'gvg_pvp') {
        updateCount++;
        badgeHtml = '<span class="gm-chip" style="background:rgba(249,115,22,0.15); color:#f97316; border:1px solid rgba(249,115,22,0.3);"><i class="ph ph-fire"></i> PvP Score: ' + fmtNum(pScore) + ' &rarr; [Participated ✓]</span>';
      } else {
        updateCount++;
        badgeHtml = '<span class="gm-chip gm-chip-success"><i class="ph ph-check"></i> ' + esc(meta.header) + ': ' + fmtNum(pScore) + ' &rarr; [Participated ✓]</span>';
      }

      html += '<tr class="ocr-row" data-pseudo="' + esc(effectivePseudo.toLowerCase()) + '">' +
        '<td class="ocr-cell-check" style="text-align: center;"><input type="checkbox" class="ocr-row-cb" data-index="' + idx + '" ' + (isChecked ? 'checked' : '') + '></td>' +
        '<td class="ocr-cell-pseudo"><input type="text" class="ocr-edit-pseudo gm-input" data-index="' + idx + '" value="' + esc(effectivePseudo) + '" placeholder="Player Username" style="padding:0.25rem 0.5rem; font-size: var(--fs-base); font-weight:600; width:100%; max-width:180px;"></td>' +
        '<td class="ocr-cell-metric"><span class="ocr-metric-label"><i class="ph ' + esc(meta.icon || 'ph-hash') + '"></i> ' + esc(meta.header || 'Score') + ':</span>' +
          '<input type="number" class="ocr-edit-power gm-input" data-index="' + idx + '" value="' + pScore + '" style="padding:0.25rem 0.5rem; font-size: var(--fs-base); font-weight:600; color:' + esc(meta.color) + '; width:100%; max-width:140px;"></td>' +
        '<td class="ocr-cell-status">' + badgeHtml + '</td>' +
      '</tr>';
    });

    if (summaryBadges) {
      summaryBadges.innerHTML =
        '<span class="gm-chip" style="background:rgba(99,102,241,0.15); color:#818cf8; border:1px solid rgba(99,102,241,0.3);"><i class="ph ph-arrows-clockwise"></i> ' + updateCount + ' Ready to Apply</span>' +
        (reconciledCount > 0 ? '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-sparkle"></i> ' + reconciledCount + ' Reconciled</span>' : '') +
        (otherGuildCount > 0 ? '<span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-slash"></i> ' + otherGuildCount + ' Ignored / Non-Tenant</span>' : '');
    }
    if (tbody) tbody.innerHTML = html;
  } else {
    if (table) { table.classList.add('ocr-table--roster'); table.classList.remove('ocr-table--event'); }
    const isMembersMode = getCurrentOcrMetric() === 'members';
    const diff = categorizeOcrDiff(players, members, activeTag(), targetField, isMultiGuild, isMembersMode ? 'members' : 'metric');
    const metricLabel = meta.header || 'Score';

    let existingHtml = '';
    if (diff.existing.length > 0) {
      existingHtml += '<tr class="ocr-section-header ocr-section-header--existing"><td colspan="' + (isMembersMode ? 6 : 5) + '"><div class="ocr-section-title"><i class="ph ph-users"></i> Existing Members <span class="gm-badge">' + diff.existing.length + '</span></div></td></tr>';
      diff.existing.forEach((item: any) => {
        const idx = item.index;
        const effPseudo = item.effectivePseudo;
        const pScore = item.newVal;
        const uid = item.uid || (item.member ? item.member.uid : '') || '';
        let badgeHtml: string;
        if (item.status === 'reconciled') badgeHtml = '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-sparkle"></i> Reconciled ("' + esc(item.member.pseudo) + '") &rarr; ' + fmtNum(pScore) + '</span>';
        else if (item.status === 'update') badgeHtml = '<span class="gm-chip" style="background:rgba(99,102,241,0.15); color:' + esc(meta.color) + '; border:1px solid rgba(99,102,241,0.3);"><i class="ph ph-arrows-clockwise"></i> Update (' + fmtNum(item.currentVal) + ' &rarr; ' + fmtNum(pScore) + ')</span>';
        else badgeHtml = '<span class="gm-chip" style="background:rgba(255,255,255,0.05); color:var(--text-muted);"><i class="ph ph-check"></i> Unchanged</span>';

        existingHtml += '<tr class="ocr-row ocr-row--existing" data-pseudo="' + esc(effPseudo.toLowerCase()) + '">' +
          '<td class="ocr-cell-check" style="text-align: center;"><input type="checkbox" class="ocr-row-cb" data-index="' + idx + '" data-section="existing" checked></td>' +
          '<td class="ocr-cell-pseudo"><input type="text" class="ocr-edit-pseudo gm-input" data-index="' + idx + '" value="' + esc(effPseudo) + '" placeholder="Player Username" style="padding:0.25rem 0.5rem; font-size: var(--fs-base); font-weight:600; width:100%; max-width:180px;"></td>' +
          '<td class="ocr-cell-uid"><span class="ocr-readonly-uid">' + esc(uid || '—') + '</span></td>' +
          (isMembersMode ? renderOcrRankCell(idx, item.ocrPlayer && item.ocrPlayer.rank, item.member && item.member.role) : '') +
          '<td class="ocr-cell-metric"><span class="ocr-metric-label"><i class="ph ' + esc(meta.icon || 'ph-hash') + '"></i> ' + esc(metricLabel) + ':</span>' +
            '<input type="number" class="ocr-edit-power gm-input" data-index="' + idx + '" value="' + pScore + '" style="padding:0.25rem 0.5rem; font-size: var(--fs-base); font-weight:600; color:' + esc(meta.color) + '; width:100%; max-width:140px;"></td>' +
          '<td class="ocr-cell-status">' + badgeHtml + '</td>' +
        '</tr>';
      });
    }
    if (tbody) tbody.innerHTML = existingHtml;

    let newHtml = '';
    if (isMembersMode) {
      if (diff.new.length > 0) {
        newHtml += '<tr class="ocr-section-header ocr-section-header--new"><td colspan="6"><div class="ocr-section-title"><i class="ph ph-user-plus"></i> New Members <span class="gm-badge">' + diff.new.length + '</span></div></td></tr>';
        diff.new.forEach((item: any) => {
          const idx = item.index;
          const effPseudo = item.effectivePseudo;
          const pScore = item.newVal;
          const uid = item.uid || (item.ocrPlayer ? item.ocrPlayer.uid : '') || '';
          const isOtherGuild = item.status === 'other_guild';
          const isChecked = !isOtherGuild;
          const uidStat = gm() && typeof gm().getUidStatus === 'function' ? gm().getUidStatus(uid) : { valid: true };
          const uidInputStyle = !uidStat.valid
            ? 'padding:0.25rem 0.5rem; font-size: var(--fs-sm); width:100%; max-width:120px; border-color:rgba(239,68,68,0.7); background:rgba(239,68,68,0.06);'
            : 'padding:0.25rem 0.5rem; font-size: var(--fs-sm); width:100%; max-width:120px;';
          const badgeHtml = isOtherGuild
            ? '<span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-slash"></i> Other Guild (Unchecked)</span>'
            : '<span class="gm-chip gm-chip-success"><i class="ph ph-user-plus"></i> New Player</span>';

          newHtml += '<tr class="ocr-row ocr-row--new" data-pseudo="' + esc(effPseudo.toLowerCase()) + '">' +
            '<td class="ocr-cell-check" style="text-align: center;"><input type="checkbox" class="ocr-row-cb" data-index="' + idx + '" data-section="new" ' + (isChecked ? 'checked' : '') + '></td>' +
            '<td class="ocr-cell-pseudo"><input type="text" class="ocr-edit-pseudo gm-input" data-index="' + idx + '" value="' + esc(effPseudo) + '" placeholder="Player Username" style="padding:0.25rem 0.5rem; font-size: var(--fs-base); font-weight:600; width:100%; max-width:180px;"></td>' +
            '<td class="ocr-cell-uid"><input type="text" class="ocr-edit-uid gm-input" data-index="' + idx + '" value="' + esc(uid) + '" placeholder="TEMP (auto)" style="' + uidInputStyle + '"></td>' +
            renderOcrRankCell(idx, item.ocrPlayer && item.ocrPlayer.rank, null) +
            '<td class="ocr-cell-metric"><span class="ocr-metric-label"><i class="ph ' + esc(meta.icon || 'ph-hash') + '"></i> ' + esc(metricLabel) + ':</span>' +
              '<input type="number" class="ocr-edit-power gm-input" data-index="' + idx + '" value="' + pScore + '" style="padding:0.25rem 0.5rem; font-size: var(--fs-base); font-weight:600; color:' + esc(meta.color) + '; width:100%; max-width:140px;"></td>' +
            '<td class="ocr-cell-status">' + badgeHtml + '</td>' +
          '</tr>';
        });
      }
    } else if (diff.unknown && diff.unknown.length > 0) {
      newHtml += '<tr class="ocr-section-header ocr-section-header--unknown"><td colspan="5"><div class="ocr-section-title" style="color:#fbbf24;"><i class="ph ph-user-focus"></i> Not in Roster <span class="gm-badge" style="background:rgba(245,158,11,0.2); color:#fbbf24;">' + diff.unknown.length + '</span></div></td></tr>';
      diff.unknown.forEach((item: any) => {
        newHtml += '<tr class="ocr-row ocr-row--unknown" data-pseudo="' + esc(String(item.effectivePseudo).toLowerCase()) + '">' +
          '<td class="ocr-cell-check" style="text-align: center;"><input type="checkbox" class="ocr-row-cb" disabled style="opacity:0.4; cursor:not-allowed;"></td>' +
          '<td class="ocr-cell-pseudo"><span style="font-weight:600; color:var(--text-muted);">' + esc(item.effectivePseudo) + '</span></td>' +
          '<td class="ocr-cell-uid"><span class="ocr-readonly-uid">—</span></td>' +
          '<td class="ocr-cell-metric"><span class="ocr-metric-label"><i class="ph ' + esc(meta.icon || 'ph-hash') + '"></i> ' + esc(metricLabel) + ':</span>' +
            '<span style="font-size: var(--fs-base); font-weight:600; color:var(--text-muted);">' + fmtNum(item.newVal) + '</span></td>' +
          '<td class="ocr-cell-status"><span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-warning"></i> Use Members OCR to add</span></td>' +
        '</tr>';
      });
    }
    if (tbodyNew) tbodyNew.innerHTML = newHtml;

    let removedHtml = '';
    if (isMembersMode && diff.removed.length > 0) {
      if (members.length > 0 && diff.removed.length > members.length * 0.5) {
        removedHtml += '<tr class="ocr-warning-row"><td colspan="6"><div class="ocr-removed-warning" style="background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.3); color:#fbbf24; padding:0.5rem 0.75rem; border-radius:6px; margin:0.35rem 0; font-size: var(--fs-sm); display:flex; align-items:center; gap:0.4rem;"><i class="ph ph-warning" style="font-size: var(--fs-xl); flex-shrink:0;"></i><span>More than half your roster would be removed. If this screenshot is partial, uncheck the members to keep.</span></div></td></tr>';
      }
      removedHtml += '<tr class="ocr-section-header ocr-section-header--removed"><td colspan="6"><div style="display:flex; justify-content:space-between; align-items:center; width:100%;"><div class="ocr-section-title"><i class="ph ph-user-minus"></i> Removed Members <span class="gm-badge gm-badge--danger">' + diff.removed.length + '</span></div><div style="font-size: var(--fs-sm); color:var(--text-muted);"><button type="button" class="gm-btn-text" id="ocr-btn-keep-all" style="font-size: var(--fs-sm); color:var(--accent); cursor:pointer; background:none; border:none; padding:0 0.4rem;">Keep All</button> | <button type="button" class="gm-btn-text" id="ocr-btn-remove-all" style="font-size: var(--fs-sm); color:#f87171; cursor:pointer; background:none; border:none; padding:0 0.4rem;">Remove All</button></div></div></td></tr>';
      diff.removed.forEach((item: any) => {
        const pseudo = item.pseudo;
        removedHtml += '<tr class="ocr-row ocr-row--removed" data-pseudo="' + esc(String(pseudo).toLowerCase()) + '" data-removal-pseudo="' + esc(pseudo) + '">' +
          '<td class="ocr-cell-check" style="text-align: center;"><input type="checkbox" class="ocr-row-cb ocr-removal-cb" data-removal-pseudo="' + esc(pseudo) + '" data-section="removed" checked></td>' +
          '<td class="ocr-cell-pseudo"><span style="font-weight:600; color:var(--text-muted);">' + esc(pseudo) + '</span></td>' +
          '<td class="ocr-cell-uid"><span class="ocr-readonly-uid">' + esc(item.uid || '—') + '</span></td>' +
          '<td class="ocr-cell-rank"><span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3); font-size: var(--fs-xs); white-space:nowrap;">' + esc(item.role || 'R1') + '</span></td>' +
          '<td class="ocr-cell-metric"><span style="color:var(--text-muted); font-size: var(--fs-base);"><i class="ph ' + esc(meta.icon || 'ph-hash') + '"></i> ' + fmtNum(item.currentPower) + '</span></td>' +
          '<td class="ocr-cell-status"><span class="ocr-removal-status-wrap"><span class="gm-chip ocr-chip-removal" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);"><i class="ph ph-user-minus"></i> To Remove</span></span></td>' +
        '</tr>';
      });
    }
    if (tbodyRemoved) tbodyRemoved.innerHTML = removedHtml;
  }

  bindOcrResultListeners(resultsContainer, tbodyRemoved);
  bindFilter(resultsContainer);
  updateCommitButtonCount();
}

function bindOcrResultListeners(resultsContainer: HTMLElement | null, tbodyRemoved: HTMLElement | null): void {
  const extracted = getOcrExtractedPlayers();
  if (!resultsContainer) return;

  resultsContainer.querySelectorAll('.ocr-row-cb:not(.ocr-removal-cb)').forEach((cb) => cb.addEventListener('change', updateCommitButtonCount));

  resultsContainer.querySelectorAll('.ocr-removal-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      const input = cb as HTMLInputElement;
      const row = input.closest('tr');
      const wrap = row ? row.querySelector('.ocr-removal-status-wrap') : null;
      if (wrap) {
        wrap.innerHTML = input.checked
          ? '<span class="gm-chip ocr-chip-removal" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);"><i class="ph ph-user-minus"></i> To Remove</span>'
          : '<span class="gm-chip ocr-chip-kept" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-check"></i> Kept</span>';
      }
      updateCommitButtonCount();
    });
  });

  resultsContainer.querySelectorAll('.ocr-edit-pseudo').forEach((input) => {
    input.addEventListener('input', () => {
      const el = input as HTMLInputElement;
      const idx = parseInt(el.getAttribute('data-index') || '', 10);
      if (extracted[idx]) extracted[idx].pseudo = el.value.trim();
      const row = el.closest('tr');
      if (row) row.setAttribute('data-pseudo', el.value.trim().toLowerCase());
    });
  });

  resultsContainer.querySelectorAll('.ocr-edit-power').forEach((input) => {
    input.addEventListener('input', () => {
      const el = input as HTMLInputElement;
      const idx = parseInt(el.getAttribute('data-index') || '', 10);
      if (extracted[idx]) { const val = parseInt(el.value, 10) || 0; extracted[idx].score = val; extracted[idx].overall_power = val; }
    });
  });

  resultsContainer.querySelectorAll('.ocr-edit-rank').forEach((select) => {
    select.addEventListener('change', () => {
      const el = select as HTMLSelectElement;
      const idx = parseInt(el.getAttribute('data-index') || '', 10);
      if (extracted[idx]) extracted[idx].rank = el.value || null;
    });
  });

  resultsContainer.querySelectorAll('.ocr-edit-uid').forEach((input) => {
    input.addEventListener('input', () => {
      const el = input as HTMLInputElement;
      const idx = parseInt(el.getAttribute('data-index') || '', 10);
      if (extracted[idx]) extracted[idx].uid = el.value.trim();
      const x = gm();
      const err = x && typeof x.validateUid === 'function' ? x.validateUid(el.value.trim()) : null;
      if (err) { el.classList.add('gm-input-error'); el.style.borderColor = '#ef4444'; }
      else { el.classList.remove('gm-input-error'); el.style.borderColor = ''; }
    });
  });

  const btnKeepAll = byId('ocr-btn-keep-all');
  if (btnKeepAll) {
    btnKeepAll.addEventListener('click', () => {
      if (!tbodyRemoved) return;
      tbodyRemoved.querySelectorAll('.ocr-removal-cb').forEach((cb) => {
        (cb as HTMLInputElement).checked = false;
        const row = (cb as HTMLElement).closest('tr');
        const wrap = row ? row.querySelector('.ocr-removal-status-wrap') : null;
        if (wrap) wrap.innerHTML = '<span class="gm-chip ocr-chip-kept" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-check"></i> Kept</span>';
      });
      updateCommitButtonCount();
    });
  }

  const btnRemoveAll = byId('ocr-btn-remove-all');
  if (btnRemoveAll) {
    btnRemoveAll.addEventListener('click', () => {
      if (!tbodyRemoved) return;
      tbodyRemoved.querySelectorAll('.ocr-removal-cb').forEach((cb) => {
        (cb as HTMLInputElement).checked = true;
        const row = (cb as HTMLElement).closest('tr');
        const wrap = row ? row.querySelector('.ocr-removal-status-wrap') : null;
        if (wrap) wrap.innerHTML = '<span class="gm-chip ocr-chip-removal" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);"><i class="ph ph-user-minus"></i> To Remove</span>';
      });
      updateCommitButtonCount();
    });
  }
}

function bindFilter(resultsContainer: HTMLElement | null): void {
  const filterSearch = byId<HTMLInputElement>('ocr-filter-search');
  if (!filterSearch) return;
  filterSearch.value = '';
  filterSearch.oninput = () => {
    const query = filterSearch.value.trim().toLowerCase();
    const rows = resultsContainer ? resultsContainer.querySelectorAll('.ocr-row') : [];
    rows.forEach((row) => {
      const pseudoInput = row.querySelector('.ocr-edit-pseudo') as HTMLInputElement | null;
      const pseudo = pseudoInput ? pseudoInput.value.toLowerCase() : (row.getAttribute('data-pseudo') || '');
      (row as HTMLElement).style.display = (!query || pseudo.indexOf(query) !== -1) ? '' : 'none';
    });
  };
}

export function toggleAllCheckboxes(checked: boolean): void {
  ['ocr-results-tbody', 'ocr-results-tbody-new'].forEach((id) => {
    const tb = byId(id);
    if (!tb) return;
    tb.querySelectorAll('.ocr-row-cb').forEach((cb) => {
      const row = (cb as HTMLElement).closest('tr');
      if (!row || row.style.display !== 'none') (cb as HTMLInputElement).checked = checked;
    });
  });
  updateCommitButtonCount();
}

export function updateCommitButtonCount(): void {
  const btnCommit = byId<HTMLButtonElement>('ocr-commit-btn');
  const tbody = byId('ocr-results-tbody');
  const tbodyNew = byId('ocr-results-tbody-new');
  const tbodyRemoved = byId('ocr-results-tbody-removed');
  const summaryBadges = byId('ocr-summary-badges');
  if (!btnCommit) return;

  const meta = getOcrMeta();
  const extracted = getOcrExtractedPlayers();

  if (meta.isEvent) {
    const count = tbody ? tbody.querySelectorAll('.ocr-row-cb:checked').length : 0;
    const span = btnCommit.querySelector('span');
    if (span) span.textContent = 'Validate & Apply ' + meta.header + ' (' + count + ')';
    btnCommit.disabled = count === 0;
    return;
  }

  if (getCurrentOcrMetric() === 'members') {
    const selectedExisting = tbody ? tbody.querySelectorAll('.ocr-row-cb:checked').length : 0;
    const selectedNew = tbodyNew ? tbodyNew.querySelectorAll('.ocr-row-cb:checked').length : 0;
    const checkedRemovals = tbodyRemoved ? tbodyRemoved.querySelectorAll('.ocr-removal-cb:checked').length : 0;
    const total = selectedExisting + selectedNew + checkedRemovals;
    const span = btnCommit.querySelector('span');
    if (span) span.textContent = 'Validate & Apply Updates (' + total + ')';
    btnCommit.disabled = total === 0;

    if (summaryBadges) {
      const members = getGuildMembers();
      const delta = computeOcrRosterDelta(members.length, selectedNew, checkedRemovals);
      const diff = categorizeOcrDiff(extracted, members, activeTag(), meta.field, meta.isMultiGuild, 'members');
      const newCount = diff.new.filter((n: any) => n.status === 'new').length;
      const updateCount = diff.existing.filter((e: any) => e.status === 'update').length;
      const reconciledCount = diff.existing.filter((e: any) => e.status === 'reconciled').length;
      const otherGuildCount = diff.new.filter((n: any) => n.status === 'other_guild').length;
      const unchangedCount = diff.existing.filter((e: any) => e.status === 'unchanged').length;
      const removalCount = diff.removed.length;
      summaryBadges.innerHTML =
        '<span class="gm-chip gm-chip-accent" style="font-weight:700;"><i class="ph ph-users-three"></i> Roster: ' + delta.before + ' &rarr; ' + delta.after + '</span>' +
        (newCount > 0 ? '<span class="gm-chip gm-chip-success"><i class="ph ph-user-plus"></i> ' + newCount + ' New</span>' : '') +
        (updateCount > 0 ? '<span class="gm-chip" style="background:rgba(99,102,241,0.15); color:#818cf8; border:1px solid rgba(99,102,241,0.3);"><i class="ph ph-arrows-clockwise"></i> ' + updateCount + ' Updates</span>' : '') +
        (reconciledCount > 0 ? '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-sparkle"></i> ' + reconciledCount + ' Reconciled</span>' : '') +
        (removalCount > 0 ? '<span class="gm-chip" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);"><i class="ph ph-user-minus"></i> ' + removalCount + ' Removed</span>' : '') +
        (otherGuildCount > 0 ? '<span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-slash"></i> ' + otherGuildCount + ' Other Guild (Unchecked)</span>' : '') +
        '<span class="gm-chip" style="background:rgba(255,255,255,0.05); color:var(--text-muted);"><i class="ph ph-check"></i> ' + unchangedCount + ' Unchanged</span>';
    }
  } else {
    const selectedExisting = tbody ? tbody.querySelectorAll('.ocr-row-cb:checked').length : 0;
    const span = btnCommit.querySelector('span');
    if (span) span.textContent = 'Validate & Apply ' + meta.header + ' (' + selectedExisting + ')';
    btnCommit.disabled = selectedExisting === 0;
  }
}

// Keep an explicit reference so the module tree-shaker keeps OCR_METRICS_META
// reachable for callers that only import the renderer.
export { OCR_METRICS_META };
