/**
 * src/modules/app/members/members.render.ts
 *
 * Sous-lot 6.6 (Strangler) — roster cards + military matrix rendering ported
 * from app.js: memberTileHtml, buildGroupedListHtml, buildMilitaryMatrixHtml,
 * renderGuildMembers, bulkUpdateMemberRoles (via members.service), absences and
 * timezone coverage. All values escaped via esc().
 */

import { styleRef } from '../../../core/dom/style-refs';
import { t, esc, byId } from '../admin/utils';
import { getActiveGuild } from '../../../core/auth/roles';
import { getAppState, patchAppState, type CollapsedRoles } from '../../../core/state/app-state';
import { getAccounts } from '../admin/admin-store';
import { filterBulkEligibleMembers, isRoleAllowedForBulk, bulkSetMemberRole } from '../../members/members.service';
import { type GuildMember, getGuildMembers, getMaxOverallPower, findGuildMember } from './members.store';
import {
  deleteGuildMember,
  showEditMemberDialog,
  showTransferMemberDialog,
  fetchGuildMembers,
} from './members.controller';
import { showToast, showConfirm } from '../dialogs/dialogs.service';
import { getClient } from '../../../core/api/supabase';
import { avatarInit, formatPower, formatNumber } from '../../../core/utils/text';
import { getPowerTier, getPowerTierMeta } from '../../../core/utils/numbers';
import { calculateRallyScore, calculateRallyGrade } from '../../../core/scoring/combat';
import { getUidStatus, isInvalidOrTempUid } from '../../ocr/ocr.service';
import { formatTimezoneDisplay, getTimezoneOffset } from '../../../utils/timezone';

/**
 * H2: delegates to the single canonical resolver instead of re-implementing the
 * fallback chain, and returns null rather than ALPHA when nothing resolves.
 */
function currentGuild(): string | null {
  return getActiveGuild();
}
function emptyStateHtml(): string {
  const members = getGuildMembers();
  if (members.length === 0) {
    return (
      '<div class="u-p-3rem-1rem u-text-center gm-empty gm-empty--coldstart">' +
      '<i class="u-fs-fs-5xl u-c-accent u-mb-1rem u-d-inline-block ph ph-scan gm-icon"></i>' +
      '<div class="u-fs-fs-xl u-fw-700 u-mb-0_5rem gm-empty-title">' +
      t('empty_members_roster_title') +
      '</div>' +
      '<div class="u-c-text-muted u-fs-fs-base u-maxw-460px u-m-0-auto-1_5rem-auto u-lh-1_4 gm-empty-desc">' +
      t('empty_members_roster_desc') +
      '</div>' +
      '<button type="button" class="btn-ocr-trigger gm-btn gm-btn-primary" data-metric="members"><i class="ph ph-scan"></i> ' +
      t('empty_members_roster_cta') +
      '</button>' +
      '</div>'
    );
  }
  return (
    '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">' +
    t('empty_members') +
    '</div></div>'
  );
}

// ── Cold-start skeleton (P3-08) ──────────────────────────────────────────────

export function membersSkeletonHtml(): string {
  const row = (w: string) =>
    '<div class="u-d-flex u-gap-12px u-items-center u-mb-10px u-minh-56px gm-card gm-card-padded gm-skeleton-card" aria-hidden="true">' +
    '<div class="u-w-44px u-h-44px u-rounded-12px u-shrink-0 gm-skeleton"></div>' +
    '<div class="u-flex-1"><div class="gm-skeleton gm-skeleton-title" data-gm-style="' +
    styleRef('width:' + w + '; height:1rem; margin-bottom:.4rem;') +
    '"></div>' +
    '<div class="u-w-65pct u-h-0_75rem gm-skeleton gm-skeleton-text"></div></div>' +
    '</div>';
  return (
    '<div class="u-p-0_25rem-0 gm-members-skeleton-list" aria-busy="true" aria-label="Loading members">' +
    row('55%') +
    row('70%') +
    row('48%') +
    row('62%') +
    '</div>'
  );
}

const ROLE_NAMES: Record<string, string> = {
  R5: 'R5 (Leader)',
  R4: 'R4 (Officer)',
  R3: 'R3 (Veteran)',
  R2: 'R2 (Member)',
  R1: 'R1 (Recruit)',
};
const ROLE_ORDER = ['R5', 'R4', 'R3', 'R2', 'R1'];

function memberKey(m: GuildMember): string {
  return String(m.pseudo || '').toLowerCase();
}

// ── Sorting (P3-04) ──────────────────────────────────────────────────────────

export function sortMembers(list: GuildMember[], sortVal: string, scoreMap?: Map<string, number>): GuildMember[] {
  const isRallySort = sortVal === 'density_desc' || sortVal === 'rally_desc' || sortVal === 'war_desc';
  let scores: Map<string, number> | null = scoreMap || null;
  if (isRallySort && !scores) {
    // Memoize calculateRallyScore once (O(n)) instead of recomputing it inside
    // every comparator call (O(n log n) score computations).
    scores = new Map();
    for (const m of list) scores.set(memberKey(m), calculateRallyScore(m));
  }
  return list.slice().sort((a: any, b: any) => {
    const pa = parseInt(a.overall_power, 10) || 0;
    const pb = parseInt(b.overall_power, 10) || 0;
    switch (sortVal) {
      case 'invalid_uid': {
        const aInv = isInvalidOrTempUid(a.uid);
        const bInv = isInvalidOrTempUid(b.uid);
        if (aInv && !bInv) return -1;
        if (!aInv && bInv) return 1;
        return pb - pa;
      }
      case 'pseudo_asc':
        return String(a.pseudo).localeCompare(String(b.pseudo));
      case 'pseudo_desc':
        return String(b.pseudo).localeCompare(String(a.pseudo));
      case 'power_desc':
        return pb - pa;
      case 'power_asc':
        return pa - pb;
      case 'fleet_desc':
        return (parseInt(b.fleet_rating, 10) || 0) - (parseInt(a.fleet_rating, 10) || 0);
      case 'tech_desc':
        return (parseInt(b.tech_power, 10) || 0) - (parseInt(a.tech_power, 10) || 0);
      case 'flagship_desc':
        return (parseInt(b.flagship_power, 10) || 0) - (parseInt(a.flagship_power, 10) || 0);
      case 'champ_desc':
        return (parseInt(b.champion_power, 10) || 0) - (parseInt(a.champion_power, 10) || 0);
      case 'crew_desc':
        return (parseInt(b.crew_power, 10) || 0) - (parseInt(a.crew_power, 10) || 0);
      case 'glory_desc':
        return (parseInt(b.glory_score, 10) || 0) - (parseInt(a.glory_score, 10) || 0);
      case 'density_desc':
      case 'rally_desc':
      case 'war_desc': {
        const ra = scores!.get(memberKey(a)) ?? 0;
        const rb = scores!.get(memberKey(b)) ?? 0;
        if (rb !== ra) return rb - ra;
        if (pb !== pa) return pb - pa;
        const fb = (parseInt(b.flagship_power, 10) || 0) - (parseInt(a.flagship_power, 10) || 0);
        if (fb !== 0) return fb;
        return (parseInt(b.fleet_rating, 10) || 0) - (parseInt(a.fleet_rating, 10) || 0);
      }
      default:
        return 0;
    }
  });
}

// ── Chips ────────────────────────────────────────────────────────────────────

export function absenceBadgeHtml(m: GuildMember): string {
  const absences: any[] = getAppState().guildAbsences || [];
  if (absences.length === 0) return '';
  const now = new Date();
  const match = absences.find((a: any) => a.uid === m.uid && new Date(a.end_date + 'T23:59:59') >= now);
  if (!match) return '';
  const active = new Date(match.start_date + 'T00:00:00') <= now;
  const kindLabel = match.kind === 'reduced' ? 'Reduced activity' : 'Absent';
  const color = active ? '#f87171' : '#fbbf24';
  const bg = active ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.12)';
  const border = active ? 'rgba(248,113,113,0.35)' : 'rgba(251,191,36,0.35)';
  const range = esc(match.start_date) + ' → ' + esc(match.end_date);
  return (
    '<span class="gm-absence-chip" data-gm-style="' +
    styleRef('color:' + color + '; border: 1px solid ' + border + '; background:' + bg + ';') +
    '" title="' +
    kindLabel +
    ' ' +
    range +
    (match.note ? ' - ' + esc(match.note) : '') +
    '">' +
    '<i class="ph ' +
    (active ? 'ph-user-minus' : 'ph-hourglass') +
    '"></i> ' +
    (active ? kindLabel : kindLabel + ' soon') +
    '</span>'
  );
}

export function timezoneChipHtml(m: GuildMember): string {
  const display = formatTimezoneDisplay(m.timezone, m.timezone_offset);
  if (!display) return '';
  return (
    '<span class="gm-tz-chip" title="' +
    esc(display.tooltip) +
    '"><i class="ph ph-clock"></i> ' +
    esc(display.offsetText) +
    '</span>'
  );
}

const ROLE_STYLES: Record<string, { color: string; bg: string; border: string; icon: string }> = {
  R5: { color: '#ffd166', bg: 'rgba(255,209,102,0.12)', border: 'rgba(255,209,102,0.3)', icon: '👑' },
  R4: { color: '#ffab76', bg: 'rgba(255,171,118,0.12)', border: 'rgba(255,171,118,0.3)', icon: '⚔️' },
  R3: { color: '#e4b5f0', bg: 'rgba(228,181,240,0.12)', border: 'rgba(228,181,240,0.3)', icon: '🛡️' },
  R2: { color: '#56c6f3', bg: 'rgba(86,198,243,0.12)', border: 'rgba(86,198,243,0.3)', icon: '👤' },
  R1: { color: '#6ee7b7', bg: 'rgba(110,231,183,0.12)', border: 'rgba(110,231,183,0.3)', icon: '🌱' },
};

// ── Member tile (cards view) ─────────────────────────────────────────────────

export function memberTileHtml(
  m: GuildMember,
  _i: number,
  withActions: boolean,
  maxPower: number,
  portalUids?: Record<string, boolean>
): string {
  const uidVal = m.uid || '-';
  const dateStr = m.created_at
    ? new Date(m.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '-';
  const initial = avatarInit(m.pseudo);
  const powerVal = parseInt(String(m.overall_power), 10) || 0;
  const meta = getPowerTierMeta(getPowerTier(powerVal, maxPower));
  const formattedPower = formatPower(powerVal);

  const roleVal = m.role || 'R1';
  const isR5 = roleVal === 'R5';
  const selected = getAppState().adminSelectedMembers;
  const isSelected = withActions && selected && selected.has(m.pseudo);
  const chkHtml = withActions
    ? '<label class="gm-member-select-chk-wrap" title="' +
      (isR5 ? t('bulk_r5_excluded_note') || 'R5 Leader cannot be modified in bulk' : 'Select member') +
      '">' +
      '<input type="checkbox" class="gm-member-select-chk admin-member-chk" data-pseudo="' +
      esc(m.pseudo) +
      '"' +
      (isSelected ? ' checked' : '') +
      (isR5 ? ' disabled' : '') +
      '>' +
      '</label>'
    : '';

  const rMeta = ROLE_STYLES[roleVal] || ROLE_STYLES.R1;
  const roleBadgeHtml =
    '<span class="gm-role-chip" data-gm-style="' +
    styleRef('color:' + rMeta.color + '; border: 1px solid ' + rMeta.border + '; background:' + rMeta.bg + ';') +
    '" title="Role ' +
    roleVal +
    '">' +
    rMeta.icon +
    ' ' +
    roleVal +
    '</span>';
  const tierBadge =
    '<span class="gm-power-tier-chip" data-gm-style="' +
    styleRef('color:' + meta.color + '; border: 1px solid ' + meta.color + '33; background: ' + meta.color + '12;') +
    '" title="' +
    meta.label +
    ' Tier"><span>' +
    meta.icon +
    '</span> ' +
    formattedPower +
    '</span>';

  const absenceBadge = absenceBadgeHtml(m);
  const timezoneChip = timezoneChipHtml(m);

  const hasPortal = portalUids && uidVal !== '-' && !!portalUids[String(uidVal)];
  const portalBadge = hasPortal
    ? '<span class="u-c-hex34d399 u-border-1px-solid-rgba-52-ceb161 u-bg-rgba-52-211-153-0_10 u-rounded-999px u-p-0_05rem-0_35rem u-fs-fs-xs u-d-inline-flex u-items-center u-gap-0_2rem gm-portal-chip" title="Player Portal account (validated)"><i class="ph ph-user-check"></i> Portal</span>'
    : '';

  const tacticalChips: string[] = [];
  if (m.fleet_rating)
    tacticalChips.push(
      '<span class="u-fs-fs-xs u-c-hex60a5fa u-bg-rgba-96-165-250-0_12 u-border-1px-solid-rgba-96-320e91 u-p-0_05rem-0_35rem u-rounded-4px gm-chip" title="Fleet Rating: ' +
        formatNumber(m.fleet_rating) +
        '">⚔️ ' +
        formatPower(m.fleet_rating) +
        '</span>'
    );
  if (m.tech_power)
    tacticalChips.push(
      '<span class="u-fs-fs-xs u-c-hexa78bfa u-bg-rgba-167-139-250-0_12 u-border-1px-solid-rgba-167-b55ab8 u-p-0_05rem-0_35rem u-rounded-4px gm-chip" title="Tech Power: ' +
        formatNumber(m.tech_power) +
        '">🔬 ' +
        formatPower(m.tech_power) +
        '</span>'
    );
  if (m.flagship_power)
    tacticalChips.push(
      '<span class="u-fs-fs-xs u-c-hexfbbf24 u-bg-rgba-251-191-36-0_12 u-border-1px-solid-rgba-251-52ad40 u-p-0_05rem-0_35rem u-rounded-4px gm-chip" title="Flagship Power: ' +
        formatNumber(m.flagship_power) +
        '">🚀 ' +
        formatPower(m.flagship_power) +
        '</span>'
    );
  if (m.glory_score)
    tacticalChips.push(
      '<span class="u-fs-fs-xs u-c-hex34d399 u-bg-rgba-52-211-153-0_12 u-border-1px-solid-rgba-52-09067f u-p-0_05rem-0_35rem u-rounded-4px gm-chip" title="Glory Score: ' +
        formatNumber(m.glory_score) +
        '">🏆 ' +
        formatPower(m.glory_score) +
        '</span>'
    );

  const tacticalHtml = tacticalChips.length
    ? '<div class="u-d-flex u-gap-0_35rem u-wrap-wrap u-mt-0_25rem gm-member-tactical-row">' +
      tacticalChips.join('') +
      '</div>'
    : withActions
      ? '<div class="u-d-flex u-gap-0_35rem u-wrap-wrap u-mt-0_25rem gm-member-tactical-row"><button type="button" class="guild-edit-btn" data-pseudo="' +
        esc(m.pseudo) +
        '" data-gm-style="' +
        styleRef(
          'font-size: var(--fs-xs); color:var(--accent); background:rgba(99,102,241,0.08); border:1px dashed rgba(99,102,241,0.3); border-radius:4px; padding:0.05rem 0.4rem; cursor:pointer; display:inline-flex; align-items:center; gap:0.25rem;'
        ) +
        '"><i class="ph ph-plus-circle"></i> + Declare Military Stats</button></div>'
      : '';

  const uidStatus = getUidStatus(m.uid);
  const uidDisplayHtml = !uidStatus.valid
    ? '<span class="gm-mono gm-uid-text gm-uid-invalid" title="' +
      esc((uidStatus.label || '') + ' — ' + (uidStatus.reason || 'Click Edit to set real game UID')) +
      '"><i class="ph ph-warning-circle"></i> UID ' +
      esc(uidVal) +
      '</span>'
    : '<span class="gm-mono gm-uid-text">UID ' + esc(uidVal) + '</span>';

  return (
    '<div class="gm-member-row' +
    (isSelected ? ' is-selected' : '') +
    '" data-pseudo="' +
    esc(m.pseudo) +
    '">' +
    '<div class="gm-member-id">' +
    chkHtml +
    '<div class="gm-avatar gm-avatar-squircle">' +
    esc(initial) +
    '</div>' +
    '<div class="gm-grow gm-truncate">' +
    '<div class="gm-member-pseudo-row">' +
    '<span class="gm-member-pseudo">' +
    esc(m.pseudo) +
    '</span>' +
    roleBadgeHtml +
    portalBadge +
    absenceBadge +
    timezoneChip +
    '</div>' +
    '<div class="u-d-flex u-dir-column u-gap-0_2rem u-items-flex-start gm-member-sub-info">' +
    '<div class="u-d-flex u-gap-0_5rem u-items-center u-wrap-wrap">' +
    uidDisplayHtml +
    tierBadge +
    '</div>' +
    tacticalHtml +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="gm-member-date"><i class="ph ph-calendar-blank"></i> <span>' +
    dateStr +
    '</span></div>' +
    (withActions
      ? '<div class="gm-member-actions">' +
        '<button class="u-c-accent gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm guild-transfer-btn" data-pseudo="' +
        esc(m.pseudo) +
        '" data-uid="' +
        esc(uidVal) +
        '" title="Transfer member to another eligible guild"><i class="ph ph-arrows-left-right"></i></button>' +
        '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm guild-edit-btn" data-pseudo="' +
        esc(m.pseudo) +
        '" title="' +
        t('edit_title') +
        '"><i class="ph ph-pencil-simple"></i></button>' +
        '<button class="u-c-danger gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm guild-delete-btn" data-pseudo="' +
        esc(m.pseudo) +
        '" title="' +
        t('delete_title') +
        '"><i class="ph ph-trash"></i></button>' +
        '</div>'
      : '') +
    '</div>'
  );
}

// ── Grouped cards HTML ───────────────────────────────────────────────────────

export function buildGroupedListHtml(
  filteredList: GuildMember[],
  sortVal: string,
  withActions: boolean,
  portalUids: Record<string, boolean>
): string {
  const maxPower = getMaxOverallPower();
  const grouped: Record<string, GuildMember[]> = { R5: [], R4: [], R3: [], R2: [], R1: [] };
  filteredList.forEach((m) => {
    const role = m.role || 'R1';
    if (!grouped[role]) grouped[role] = [];
    grouped[role].push(m);
  });

  let html = '';
  let hasAny = false;
  ROLE_ORDER.forEach((role) => {
    const membersInRole = grouped[role] || [];
    if (membersInRole.length === 0) return;
    hasAny = true;
    // Phase 7: read the typed store rather than the `window` mirror it writes
    // to. Both sides were reading the same object, but only one of them was
    // checked by the compiler.
    const collapsed = !!getAppState().collapsedRoles[role as keyof CollapsedRoles];
    const sorted = sortMembers(membersInRole, sortVal);

    html +=
      '<div class="gm-role-group' +
      (collapsed ? ' is-collapsed' : '') +
      '">' +
      '<div class="gm-role-group-header" data-role="' +
      role +
      '">' +
      '<div class="gm-role-group-title">' +
      '<i class="ph ph-caret-down gm-role-group-caret"></i>' +
      '<span class="gm-role-chip">' +
      role +
      '</span>' +
      '<span class="gm-role-group-name">' +
      esc(ROLE_NAMES[role] || role) +
      '</span>' +
      '<span class="gm-role-group-count">(' +
      membersInRole.length +
      ')</span>' +
      '</div>' +
      '</div>' +
      '<div class="gm-role-group-body">' +
      '<div class="admin-members-grid' +
      (withActions ? '' : ' gm-member-grid-member') +
      '">';
    sorted.forEach((m, i) => {
      html += memberTileHtml(m, i, withActions, maxPower, portalUids);
    });
    html += '</div></div></div>';
  });

  if (!hasAny) return emptyStateHtml();
  return html;
}

// ── Military matrix ──────────────────────────────────────────────────────────

export function buildMilitaryMatrixHtml(
  list: GuildMember[],
  sortVal?: string,
  withActions = false,
  _portalUids?: Record<string, boolean>
): string {
  sortVal = sortVal || 'rally_desc';

  // P3-04: compute every rally score once into a memo map, then reuse it for
  // the ranking sort, the display order and every per-row badge (no repeated
  // calculateRallyScore calls, no double sort on rally views).
  const scoreMap = new Map<string, number>();
  for (const m of list) scoreMap.set(memberKey(m), calculateRallyScore(m));

  const isRallyView = sortVal === 'rally_desc' || sortVal === 'war_desc' || sortVal === 'density_desc';

  const rallyRankedList = list.slice().sort((a: any, b: any) => {
    const ra = scoreMap.get(memberKey(a)) ?? 0;
    const rb = scoreMap.get(memberKey(b)) ?? 0;
    if (rb !== ra) return rb - ra;
    const pb = (parseInt(b.overall_power, 10) || 0) - (parseInt(a.overall_power, 10) || 0);
    if (pb !== 0) return pb;
    const fb = (parseInt(b.flagship_power, 10) || 0) - (parseInt(a.flagship_power, 10) || 0);
    if (fb !== 0) return fb;
    return (parseInt(b.fleet_rating, 10) || 0) - (parseInt(a.fleet_rating, 10) || 0);
  });

  // Single sort: on rally views the ranking IS the table order.
  const sorted = isRallyView ? rallyRankedList : sortMembers(list, sortVal, scoreMap);
  if (sorted.length === 0) return emptyStateHtml();

  let maxRallyScore = 0;
  const rallyRankMap: Record<string, { isLeader: boolean; rank: number }> = {};
  let leaderCount = 0;
  rallyRankedList.forEach((m, idx) => {
    const pKey = memberKey(m);
    const rScore = scoreMap.get(pKey) ?? 0;
    if (rScore > maxRallyScore) maxRallyScore = rScore;
    if (idx < 16 && rScore > 0) {
      leaderCount++;
      rallyRankMap[pKey] = { isLeader: true, rank: idx + 1 };
    } else rallyRankMap[pKey] = { isLeader: false, rank: idx + 1 };
  });

  let totalFleet = 0,
    totalTech = 0,
    totalGlory = 0;
  sorted.forEach((m) => {
    totalFleet += parseInt(String(m.fleet_rating), 10) || 0;
    totalTech += parseInt(String(m.tech_power), 10) || 0;
    totalGlory += parseInt(String(m.glory_score), 10) || 0;
  });

  const headerSummary =
    '<div class="u-d-flex u-justify-space-between u-items-center u-wrap-wrap u-gap-0_75rem u-mb-1rem u-p-0_85rem-1rem u-bg-bg-1 u-border-1px-solid-border-soft u-rounded-radius-lg">' +
    '<div class="u-fw-700 u-fs-fs-md u-c-fg u-d-flex u-items-center u-gap-0_4rem u-wrap-wrap">' +
    '<i class="u-c-accent ph ph-shield"></i> Tactical Force Matrix (' +
    sorted.length +
    ' players)' +
    '<span class="u-c-hexfacc15 u-bg-rgba-234-179-8-0_12 u-border-1px-solid-rgba-234-179-8-0_3 u-fs-fs-xs u-ml-0_35rem gm-chip" title="16 Top Rally Leaders automatically assigned"><i class="ph ph-crown-simple"></i> ' +
    leaderCount +
    ' Rally Leaders</span>' +
    '</div>' +
    '<div class="u-d-flex u-gap-0_5rem u-wrap-wrap u-items-center">' +
    '<span class="u-c-hex60a5fa u-bg-rgba-96-165-250-0_12 u-border-1px-solid-rgba-96-320e91 u-fs-fs-sm gm-chip"><i class="ph ph-sword"></i> Guild Fleet: ' +
    formatPower(totalFleet) +
    '</span>' +
    '<span class="u-c-hexa78bfa u-bg-rgba-167-139-250-0_12 u-border-1px-solid-rgba-167-b55ab8 u-fs-fs-sm gm-chip"><i class="ph ph-atom"></i> Guild Tech: ' +
    formatPower(totalTech) +
    '</span>' +
    '<span class="u-c-hex34d399 u-bg-rgba-52-211-153-0_12 u-border-1px-solid-rgba-52-09067f u-fs-fs-sm gm-chip"><i class="ph ph-trophy"></i> Total Glory: ' +
    formatPower(totalGlory) +
    '</span>' +
    '</div>' +
    '</div>';

  const selected = getAppState().adminSelectedMembers;
  const eligibleInList = list.filter((m) => m && m.pseudo && m.role !== 'R5');
  const allSelected = withActions && eligibleInList.length > 0 && eligibleInList.every((m) => selected.has(m.pseudo));

  const rowsHtml = sorted
    .map((m: any) => {
      const initial = avatarInit(m.pseudo);
      const uidVal = m.uid || '-';
      const roleVal = m.role || 'R1';
      const powerVal = parseInt(m.overall_power, 10) || 0;
      const rallyScore = scoreMap.get(memberKey(m)) ?? 0;
      const rallyGrade = calculateRallyGrade(m, maxRallyScore);
      const rallyInfo = rallyRankMap[(m.pseudo || '').toLowerCase()] || { isLeader: false, rank: 999 };
      let rallyRoleChip: string;
      if (rallyInfo.isLeader) {
        if (rallyInfo.rank <= 4)
          rallyRoleChip =
            '<span class="u-bg-rgba-234-179-8-0_18 u-c-hexfacc15 u-fs-fs-xs u-fw-700 u-border-1px-solid-rgba-234-f8c743 u-p-0_12rem-0_5rem gm-chip" title="Top Tier Rally Leader #' +
            rallyInfo.rank +
            '"><i class="ph ph-crown-simple"></i> Leader #' +
            rallyInfo.rank +
            '</span>';
        else if (rallyInfo.rank <= 8)
          rallyRoleChip =
            '<span class="u-bg-rgba-168-85-247-0_18 u-c-hexc084fc u-fs-fs-xs u-fw-700 u-border-1px-solid-rgba-168-d904af u-p-0_12rem-0_5rem gm-chip" title="Elite Rally Leader #' +
            rallyInfo.rank +
            '"><i class="ph ph-shield-star"></i> Leader #' +
            rallyInfo.rank +
            '</span>';
        else
          rallyRoleChip =
            '<span class="u-bg-rgba-59-130-246-0_18 u-c-hex60a5fa u-fs-fs-xs u-fw-700 u-border-1px-solid-rgba-59-39cd06 u-p-0_12rem-0_5rem gm-chip" title="Rally Leader #' +
            rallyInfo.rank +
            '"><i class="ph ph-target"></i> Leader #' +
            rallyInfo.rank +
            '</span>';
      } else {
        rallyRoleChip =
          '<span class="u-bg-rgba-148-163-184-0_12 u-c-text-muted u-fs-fs-xs u-border-1px-solid-border-soft u-p-0_1rem-0_45rem gm-chip" title="Rally Reinforcement / Joiner"><i class="ph ph-users"></i> Rally Joiner</span>';
      }

      const uidStatus = getUidStatus(m.uid);
      const uidHtml = !uidStatus.valid
        ? '<div data-gm-style="' +
          styleRef('font-size: var(--fs-xs); margin-top:2px;') +
          '" class="gm-mono gm-uid-invalid" title="' +
          esc((uidStatus.label || '') + ' — ' + (uidStatus.reason || '')) +
          '"><i class="ph ph-warning-circle"></i> UID ' +
          esc(uidVal) +
          '</div>'
        : '<div data-gm-style="' +
          styleRef('font-size: var(--fs-xs); color:var(--text-muted);') +
          '" class="gm-mono">UID ' +
          esc(uidVal) +
          '</div>';

      const isR5 = roleVal === 'R5';
      const isSelected = withActions && selected.has(m.pseudo);
      const chkHtml = withActions
        ? '<label class="gm-member-select-chk-wrap" title="' +
          (isR5 ? t('bulk_r5_excluded_note') || 'R5 Leader cannot be modified in bulk' : 'Select member') +
          '">' +
          '<input type="checkbox" class="gm-member-select-chk admin-member-chk" data-pseudo="' +
          esc(m.pseudo) +
          '"' +
          (isSelected ? ' checked' : '') +
          (isR5 ? ' disabled' : '') +
          '>' +
          '</label>'
        : '';

      return (
        '<tr class="u-bb-1px-solid-border-soft ' +
        (isSelected ? 'is-selected' : '') +
        '" data-pseudo="' +
        esc(m.pseudo) +
        '">' +
        '<td class="u-p-0_65rem-0_75rem"><div class="u-d-flex u-items-center u-gap-0_5rem">' +
        chkHtml +
        '<div class="u-w-28px u-h-28px u-fs-fs-sm gm-avatar gm-avatar-squircle">' +
        esc(initial) +
        '</div>' +
        '<div><div class="u-fw-600 u-fs-fs-base u-c-fg">' +
        esc(m.pseudo) +
        '</div>' +
        uidHtml +
        '</div>' +
        '</div></td>' +
        '<td data-label="Rally" class="u-p-0_65rem-0_5rem u-text-center">' +
        rallyRoleChip +
        '</td>' +
        '<td data-label="Role" class="u-p-0_65rem-0_5rem u-text-center"><span class="u-fs-fs-xs u-p-0_1rem-0_35rem gm-role-chip" data-role="' +
        esc(roleVal) +
        '">' +
        esc(roleVal) +
        '</span></td>' +
        '<td data-label="Power" class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-fw-600 u-fs-fs-base gm-matrix-num tabular-nums">' +
        formatPower(powerVal) +
        '</td>' +
        '<td data-label="Fleet" class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hex60a5fa u-fw-600 u-fs-fs-base gm-matrix-num tabular-nums">' +
        (m.fleet_rating ? formatPower(m.fleet_rating) : '<span class="u-c-text-muted u-opacity-0_4">—</span>') +
        '</td>' +
        '<td data-label="Tech" class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hexa78bfa u-fw-600 u-fs-fs-base gm-matrix-num tabular-nums">' +
        (m.tech_power ? formatPower(m.tech_power) : '<span class="u-c-text-muted u-opacity-0_4">—</span>') +
        '</td>' +
        '<td data-label="Flagship" class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hexfbbf24 u-fw-600 u-fs-fs-base gm-matrix-num tabular-nums">' +
        (m.flagship_power ? formatPower(m.flagship_power) : '<span class="u-c-text-muted u-opacity-0_4">—</span>') +
        '</td>' +
        '<td data-label="Champs" class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hexf472b6 u-fw-600 u-fs-fs-base gm-matrix-num tabular-nums">' +
        (m.champion_power ? formatPower(m.champion_power) : '<span class="u-c-text-muted u-opacity-0_4">—</span>') +
        '</td>' +
        '<td data-label="Crew" class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hex38bdf8 u-fw-600 u-fs-fs-base gm-matrix-num tabular-nums">' +
        (m.crew_power ? formatPower(m.crew_power) : '<span class="u-c-text-muted u-opacity-0_4">—</span>') +
        '</td>' +
        '<td data-label="Glory" class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hex34d399 u-fw-600 u-fs-fs-base gm-matrix-num tabular-nums">' +
        (m.glory_score ? formatPower(m.glory_score) : '<span class="u-c-text-muted u-opacity-0_4">—</span>') +
        '</td>' +
        '<td data-label="Rally Score" class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums gm-matrix-num tabular-nums">' +
        (rallyScore > 0
          ? '<span class="u-d-inline-flex u-justify-flex-end u-fvn-tabular-nums u-fw-700 u-fs-fs-sm u-c-hex818cf8 u-bg-rgba-99-102-241-0_15 u-border-1px-solid-rgba-99-34aac1 u-p-0_15rem-0_5rem u-gap-0_25rem gm-chip"><i class="ph ph-lightning"></i> ' +
            rallyGrade +
            '/100</span>'
          : '<span class="u-c-text-muted u-opacity-0_4">—</span>') +
        '</td>' +
        '<td data-label="Action" class="u-p-0_65rem-0_75rem u-text-center">' +
        '<button type="button" class="gm-btn gm-btn-ghost gm-btn-sm guild-edit-btn" data-pseudo="' +
        esc(m.pseudo) +
        '" title="Edit Player Military Metrics"><i class="ph ph-pencil-simple"></i> Edit</button>' +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  return (
    headerSummary +
    '<div class="u-bg-bg-1 u-border-1px-solid-border-soft u-rounded-radius-lg u-ox-auto gm-table-wrap">' +
    '<table class="u-w-100pct u-bcol-collapse u-minw-850px gm-table gm-resp-table">' +
    '<thead><tr class="u-bg-rgba-255-255-255-0_03 u-bb-1px-solid-border-soft u-fs-fs-xs u-tt-uppercase u-c-text-muted">' +
    '<th class="u-p-0_65rem-0_75rem u-text-left">' +
    (withActions
      ? '<label class="gm-member-select-chk-wrap"><input type="checkbox" class="gm-member-select-chk admin-matrix-select-all-chk"' +
        (allSelected ? ' checked' : '') +
        '></label> '
      : '') +
    '<span>Player</span></th>' +
    '<th class="u-p-0_65rem-0_5rem u-text-center u-c-hexfacc15">🎯 Rally</th>' +
    '<th class="u-p-0_65rem-0_5rem u-text-center">Role</th>' +
    '<th class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums gm-matrix-num tabular-nums">Power</th>' +
    '<th class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hex60a5fa gm-matrix-num tabular-nums">⚔️ Fleet</th>' +
    '<th class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hexa78bfa gm-matrix-num tabular-nums">🔬 Tech</th>' +
    '<th class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hexfbbf24 gm-matrix-num tabular-nums">🚀 Flagship</th>' +
    '<th class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hexf472b6 gm-matrix-num tabular-nums">👑 Champs</th>' +
    '<th class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hex38bdf8 gm-matrix-num tabular-nums">👥 Crew</th>' +
    '<th class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hex34d399 gm-matrix-num tabular-nums">🏆 Glory</th>' +
    '<th class="u-p-0_65rem-0_5rem u-text-right u-fvn-tabular-nums u-c-hex818cf8 gm-matrix-num tabular-nums">⚡ Rally Score</th>' +
    '<th class="u-p-0_65rem-0_75rem u-text-center">Action</th>' +
    '</tr></thead>' +
    '<tbody>' +
    rowsHtml +
    '</tbody>' +
    '</table>' +
    '</div>'
  );
}

// Compatibility aliases used by legacy callers/tests.
export const _buildMilitaryMatrixHtml = buildMilitaryMatrixHtml;

// ── Absence / timezone panels ────────────────────────────────────────────────

export function renderAbsenceSummary(): void {
  const section = byId('admin-absences-section');
  const listEl = byId('admin-absences-list');
  const countEl = byId('admin-absences-count');
  if (!section || !listEl || !countEl) return;

  const absences: any[] = getAppState().guildAbsences || [];
  const now = new Date();
  const relevant = absences.filter((a: any) => new Date(a.end_date + 'T23:59:59') >= now);
  relevant.sort((a: any, b: any) => {
    const aa = new Date(a.start_date + 'T00:00:00') <= now ? 0 : 1;
    const ba = new Date(b.start_date + 'T00:00:00') <= now ? 0 : 1;
    if (aa !== ba) return aa - ba;
    return String(a.start_date).localeCompare(String(b.start_date));
  });
  section.classList.toggle('hidden', relevant.length === 0);
  if (relevant.length === 0) return;

  countEl.textContent = String(relevant.length);

  const membersByUid: Record<string, GuildMember> = {};
  getGuildMembers().forEach((m) => {
    membersByUid[String(m.uid)] = m;
  });

  let html = '<div class="gm-absence-grid">';
  relevant.forEach((a: any) => {
    const member = membersByUid[String(a.uid)];
    const active = new Date(a.start_date + 'T00:00:00') <= now;
    const kindLabel = a.kind === 'reduced' ? 'Reduced activity' : 'Full absence';
    const color = active ? '#f87171' : '#fbbf24';
    const bg = active ? 'rgba(248,113,113,0.10)' : 'rgba(251,191,36,0.10)';
    const border = active ? 'rgba(248,113,113,0.35)' : 'rgba(251,191,36,0.35)';
    html +=
      '<div class="gm-absence-card">' +
      '<div class="gm-absence-card-head">' +
      '<div class="gm-avatar gm-avatar-sm" data-gm-style="' +
      styleRef('background:' + bg + '; color:' + color + ';') +
      '">' +
      esc(avatarInit(member ? member.pseudo : a.pseudo || '?')) +
      '</div>' +
      '<div class="gm-grow"><div class="gm-absence-card-name">' +
      esc(member ? member.pseudo : a.pseudo || a.uid) +
      '</div>' +
      '<div class="gm-absence-card-kind" data-gm-style="' +
      styleRef('color:' + color + ';') +
      '">' +
      esc(kindLabel) +
      '</div></div>' +
      '<span class="gm-absence-card-status" data-gm-style="' +
      styleRef('color:' + color + '; border: 1px solid ' + border + '; background:' + bg + ';') +
      '">' +
      (active ? 'Active' : 'Upcoming') +
      '</span>' +
      '</div>' +
      '<div class="gm-absence-card-dates"><i class="ph ph-calendar-dots"></i> ' +
      esc(a.start_date) +
      ' → ' +
      esc(a.end_date) +
      '</div>' +
      (a.note ? '<div class="gm-absence-card-note">' + esc(a.note) + '</div>' : '') +
      '</div>';
  });
  html += '</div>';
  listEl.innerHTML = html;
}

export function renderTimezoneCoverage(): void {
  const section = byId('admin-timezone-section');
  const listEl = byId('admin-timezone-list');
  const countEl = byId('admin-timezone-count');
  if (!section || !listEl || !countEl) return;

  const currentG = currentGuild();
  const members = getGuildMembers();
  const withTz = members.filter((m) => {
    // H2: a member with no guild belongs to no guild, not to ALPHA.
    if ((m.guild || '') !== currentG) return false;
    return !!m.timezone || (m.timezone_offset != null && !isNaN(Number(m.timezone_offset)));
  });
  section.classList.toggle('hidden', withTz.length === 0);
  if (withTz.length === 0) return;

  countEl.textContent = withTz.length + '/' + members.length;

  const now = new Date();
  const nowUtcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  const buckets: Record<number, GuildMember[]> = {};
  withTz.forEach((m) => {
    const offset = m.timezone ? getTimezoneOffset(m.timezone, now) : Number(m.timezone_offset);
    const localHour = Math.floor((((nowUtcHours + offset) % 24) + 24) % 24);
    if (!buckets[localHour]) buckets[localHour] = [];
    buckets[localHour].push(m);
  });

  let maxCount = 0;
  Object.keys(buckets).forEach((h) => {
    if (buckets[Number(h)].length > maxCount) maxCount = buckets[Number(h)].length;
  });
  if (maxCount <= 0) maxCount = 1;

  let html = '<div class="gm-tz-histogram">';
  for (let h = 0; h < 24; h++) {
    const list = buckets[h] || [];
    const pct = Math.round((list.length / maxCount) * 100);
    const isPeak = list.length === maxCount && list.length > 0;
    const label = String(h).padStart(2, '0') + ':00';
    const names = list.map((m) => m.pseudo).join(', ');
    html +=
      '<div class="gm-tz-bar-row"' +
      (names ? ' title="' + esc(names) + '"' : '') +
      '>' +
      '<span class="gm-tz-bar-label">' +
      label +
      '</span>' +
      '<div class="gm-tz-bar-track"><div class="gm-tz-bar' +
      (isPeak ? ' gm-tz-bar-peak' : '') +
      '" data-gm-style="' +
      styleRef('width:' + pct + '%;') +
      '"></div></div>' +
      '<span class="gm-tz-bar-count">' +
      list.length +
      '</span>' +
      '</div>';
  }
  html += '</div>';
  listEl.innerHTML = html;
}

// ── Bulk actions ─────────────────────────────────────────────────────────────

export function updateBulkActionBar(filteredList: GuildMember[]): void {
  const bar = byId('admin-members-bulk-bar');
  const countSpan = byId('admin-bulk-selected-count');
  if (!bar || !countSpan) return;

  const activeGuild = currentGuild();
  const selected = getAppState().adminSelectedMembers;
  const rosterMap: Record<string, GuildMember> = {};
  getGuildMembers()
    .filter((m) => (m.guild || '') === activeGuild)
    .forEach((m) => {
      if (m && m.pseudo) rosterMap[m.pseudo] = m;
    });

  Array.from(selected).forEach((p) => {
    const mem = rosterMap[p];
    if (!mem || mem.role === 'R5') selected.delete(p);
  });

  const count = selected.size;
  if (count > 0) {
    countSpan.textContent = (t('bulk_selected_count') || '{n} selected').replace('{n}', String(count));
    bar.style.display = 'block';
    requestAnimationFrame(() => bar.classList.add('is-visible'));
  } else {
    bar.classList.remove('is-visible');
    setTimeout(() => {
      if (selected.size === 0) bar.style.display = 'none';
    }, 280);
  }
  updateSelectAllBtnState(filteredList);
}

export function updateSelectAllBtnState(filteredList: GuildMember[]): void {
  const selectAllBtn = byId('admin-members-select-all-btn');
  if (!selectAllBtn) return;
  const selected = getAppState().adminSelectedMembers;
  const eligible = (filteredList || []).filter((m) => m && m.pseudo && m.role !== 'R5');
  const allSelected = eligible.length > 0 && eligible.every((m) => selected.has(m.pseudo));
  const labelSpan = selectAllBtn.querySelector('span');
  const icon = selectAllBtn.querySelector('i');
  if (allSelected) {
    if (labelSpan) labelSpan.textContent = t('bulk_deselect_all') || 'Deselect All';
    if (icon) icon.className = 'ph ph-check-square-offset';
    selectAllBtn.classList.add('active');
  } else {
    if (labelSpan) labelSpan.textContent = t('bulk_select_all') || 'Select All';
    if (icon) icon.className = 'ph ph-check-square';
    selectAllBtn.classList.remove('active');
  }
}

/** Bulk role assignment (R5 protected by members.service). */
export async function bulkUpdateMemberRoles(targetRole: string): Promise<boolean> {
  if (!isRoleAllowedForBulk(targetRole)) {
    showToast('Invalid role. R5 Leader cannot be assigned in bulk.', 'error');
    return false;
  }

  const activeGuild = currentGuild();
  const currentRoster = getGuildMembers().filter((m) => (m.guild || '') === activeGuild);
  const { eligiblePseudos, excludedR5Count } = filterBulkEligibleMembers(
    currentRoster,
    getAppState().adminSelectedMembers
  );

  if (!eligiblePseudos || eligiblePseudos.length === 0) {
    const msg =
      excludedR5Count > 0
        ? 'Only the R5 Leader was selected — leadership is protected and cannot be modified in bulk.'
        : t('toast_no_members_selected') || 'No eligible members selected';
    showToast(msg, 'error');
    return false;
  }

  try {
    const db = getClient();
    if (!db) throw new Error('no_client');
    const res = await bulkSetMemberRole(db, activeGuild, eligiblePseudos, targetRole);
    if (res.error) throw res.error;

    const updatedCount = eligiblePseudos.length;
    getAppState().adminSelectedMembers.clear();
    await fetchGuildMembers();

    const msg = (t('toast_bulk_role_updated') || '{n} member(s) successfully assigned to rank {role}')
      .replace('{n}', String(updatedCount))
      .replace('{role}', targetRole);
    showToast(msg, 'success');
    return true;
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
    return false;
  }
}

// ── Main renderer ────────────────────────────────────────────────────────────

export function renderGuildMembers(skipSubpanels?: boolean): void {
  const qAdminInput = byId<HTMLInputElement>('member-search-admin');
  const qAdmin = qAdminInput ? qAdminInput.value.toLowerCase() : '';
  const tierAdminSelect = byId<HTMLSelectElement>('member-tier-filter-admin');
  const tAdmin = tierAdminSelect ? tierAdminSelect.value : 'ALL';
  const sortAdminSelect = byId<HTMLSelectElement>('member-sort-admin');
  const sortAdmin = sortAdminSelect ? sortAdminSelect.value : 'power_desc';

  if (!skipSubpanels) {
    renderAbsenceSummary();
    renderTimezoneCoverage();
  }

  const members = getGuildMembers();
  const maxPower = members.length ? getMaxOverallPower() : 0;

  const portalUids: Record<string, boolean> = {};
  getAccounts().forEach((a) => {
    if (a.role === 'member' && a.status === 'active' && a.uid) portalUids[String(a.uid)] = true;
  });

  const currentG = currentGuild();

  const filteredAdmin = members.filter((m) => {
    const memberG = m.guild || '';
    const matchGuild = memberG === currentG;
    const matchSearch =
      (String(m.pseudo).toLowerCase() + ' ' + String(m.uid || '').toLowerCase()).indexOf(qAdmin) !== -1;
    let matchTier: boolean;
    if (tAdmin === 'ALL') matchTier = true;
    else if (tAdmin === 'TEMP_UID') matchTier = isInvalidOrTempUid(m.uid);
    else matchTier = getPowerTier(parseInt(String(m.overall_power), 10) || 0, maxPower) === tAdmin;
    return matchGuild && matchSearch && matchTier;
  });

  const guildMemberCount = byId('guild-member-count');
  if (guildMemberCount) guildMemberCount.textContent = String(filteredAdmin.length);

  const guildMemberList = byId('guild-member-list');
  if (guildMemberList) {
    const viewMode = getAppState().adminMembersViewMode;
    if (viewMode === 'matrix') {
      const currentMatrixSort = sortAdminSelect && sortAdminSelect.value !== 'power_desc' ? sortAdmin : 'rally_desc';
      guildMemberList.innerHTML = buildMilitaryMatrixHtml(filteredAdmin, currentMatrixSort, true, portalUids);
    } else {
      guildMemberList.innerHTML = buildGroupedListHtml(filteredAdmin, sortAdmin, true, portalUids);
    }
  }

  updateBulkActionBar(filteredAdmin);
  updateTempUidBadge();
  wireRosterInteractions(filteredAdmin);
}

/** Temporary/invalid-UID badge with click-to-filter (app.js parity). */
function updateTempUidBadge(): void {
  const badge = byId('guild-member-temp-uid-badge');
  const countSpan = byId('guild-member-temp-uid-count');
  if (!badge || !countSpan) return;
  const currentG = currentGuild();
  const count = getGuildMembers().filter((m) => (m.guild || '') === currentG && isInvalidOrTempUid(m.uid)).length;

  if (count > 0) {
    countSpan.textContent = String(count);
    badge.style.display = 'inline-flex';
    badge.setAttribute('title', count + ' member(s) with temporary or invalid UID. Click to filter.');
    if (!badge.hasAttribute('data-wired')) {
      badge.setAttribute('data-wired', '1');
      badge.addEventListener('click', () => {
        const tierSelect = byId<HTMLSelectElement>('member-tier-filter-admin');
        if (tierSelect) {
          tierSelect.value = tierSelect.value === 'TEMP_UID' ? 'ALL' : 'TEMP_UID';
          tierSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }
  } else {
    badge.style.display = 'none';
  }
}

// ── Roster event delegation (P3-04) ──────────────────────────────────────────
// Bound ONCE per page: every click/change on the roster is routed through a
// single delegated handler on `document`, reading the current filtered roster
// from the module context. No more per-node addEventListener + re-binding on
// every render.

let rosterDelegationBound = false;
let rosterCtx: GuildMember[] = [];

function bindRosterDelegation(): void {
  if (rosterDelegationBound || typeof document === 'undefined') return;
  rosterDelegationBound = true;

  document.addEventListener('change', (ev: Event) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    const selected = getAppState().adminSelectedMembers;

    if (target.classList.contains('admin-member-chk')) {
      const pseudo = target.getAttribute('data-pseudo');
      if (!pseudo) return;
      if (target.checked) selected.add(pseudo);
      else selected.delete(pseudo);
      updateBulkActionBar(rosterCtx);
      const rowOrCard = target.closest('.gm-member-row, tr');
      if (rowOrCard) rowOrCard.classList.toggle('is-selected', target.checked);
      return;
    }

    if (target.classList.contains('admin-matrix-select-all-chk')) {
      const eligible = rosterCtx.filter((m) => m && m.pseudo && m.role !== 'R5');
      if (target.checked) eligible.forEach((m) => selected.add(m.pseudo));
      else eligible.forEach((m) => selected.delete(m.pseudo));
      renderGuildMembers();
    }
  });

  document.addEventListener('click', (ev: Event) => {
    const target = ev.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const selected = getAppState().adminSelectedMembers;

    const roleHeader = target.closest<HTMLElement>('.gm-role-group-header');
    if (roleHeader) {
      const role = roleHeader.getAttribute('data-role');
      if (!role) return;
      // Phase 7: go through the store, which mirrors onto `window` itself.
      // Poking the mirror directly left `getAppState()` reporting the previous
      // value until something else happened to re-hydrate it.
      const key = role as keyof CollapsedRoles;
      const current = getAppState().collapsedRoles;
      patchAppState({ collapsedRoles: { ...current, [key]: !current[key] } });
      renderGuildMembers();
      return;
    }

    const segBtn = target.closest<HTMLElement>('#admin-members-view-mode .gm-seg-btn');
    if (segBtn) {
      const v = segBtn.getAttribute('data-view') === 'matrix' ? 'matrix' : 'cards';
      patchAppState({ adminMembersViewMode: v });
      document.querySelectorAll('#admin-members-view-mode .gm-seg-btn').forEach((b) => {
        const bb = b as HTMLElement;
        const isActive = bb.getAttribute('data-view') === v;
        bb.classList.toggle('active', isActive);
        bb.style.background = isActive ? 'var(--accent-strong)' : 'transparent';
        bb.style.color = isActive ? '#fff' : 'var(--text-muted)';
      });
      renderGuildMembers();
      return;
    }

    const selectAllBtn = target.closest<HTMLElement>('#admin-members-select-all-btn');
    if (selectAllBtn) {
      const eligible = rosterCtx.filter((m) => m && m.pseudo && m.role !== 'R5');
      const allSelected = eligible.length > 0 && eligible.every((m) => selected.has(m.pseudo));
      if (allSelected) eligible.forEach((m) => selected.delete(m.pseudo));
      else eligible.forEach((m) => selected.add(m.pseudo));
      renderGuildMembers();
      return;
    }

    const bulkClearBtn = target.closest<HTMLElement>('#admin-bulk-clear-btn');
    if (bulkClearBtn) {
      selected.clear();
      renderGuildMembers();
      return;
    }

    const bulkRoleBtn = target.closest<HTMLElement>('.gm-bulk-role-btn');
    if (bulkRoleBtn) {
      void bulkUpdateMemberRoles(bulkRoleBtn.getAttribute('data-role') || '');
      return;
    }

    const transferBtn = target.closest<HTMLElement>('.guild-transfer-btn');
    if (transferBtn) {
      const member = findGuildMember(transferBtn.getAttribute('data-pseudo') || '');
      if (member) void showTransferMemberDialog(member);
      return;
    }

    const editBtn = target.closest<HTMLElement>('.guild-edit-btn');
    if (editBtn) {
      const member = findGuildMember(editBtn.getAttribute('data-pseudo') || '');
      if (member) void showEditMemberDialog(member);
      return;
    }

    const deleteBtn = target.closest<HTMLElement>('.guild-delete-btn');
    if (deleteBtn) {
      const pseudo = deleteBtn.getAttribute('data-pseudo') || '';
      showConfirm(
        t('confirm_remove_member_title'),
        t('confirm_remove_member_body') + ' <strong>' + esc(pseudo) + '</strong> ' + t('confirm_remove_member_body2'),
        () => {
          void deleteGuildMember(pseudo);
        }
      );
    }
  });
}

function wireRosterInteractions(filteredAdmin: GuildMember[]): void {
  rosterCtx = filteredAdmin;
  bindRosterDelegation();
}
