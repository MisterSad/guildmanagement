/**
 * src/modules/app/admin/migration-groups.controller.ts
 *
 * Sous-lot 6.5 (Strangler) — cross-server migration groups panel ported from
 * app.js#renderMigrationGroupsList (super-admin create/open/close/reopen).
 */

import { esc, byId, getDb } from './utils';
import { showToast, showConfirm } from '../dialogs/dialogs.service';
import {
  createMigrationGroup,
  queryMigrationGroups,
  queryMigrationGroupServers,
  updateMigrationGroup,
} from '../../migration/migration.service';

let migrationGroupsFormWired = false;

export async function renderMigrationGroupsList(): Promise<void> {
  const container = byId('migration-groups-list-container');
  const db = getDb();
  if (!container || !db) return;

  if (!migrationGroupsFormWired) {
    migrationGroupsFormWired = true;
    const form = byId<HTMLFormElement>('create-migration-group-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nameInput = byId<HTMLInputElement>('migration-group-name');
        const serversInput = byId<HTMLInputElement>('migration-group-servers');
        const name = nameInput ? nameInput.value.trim() : '';
        const serverNumbers = serversInput
          ? serversInput.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const uniqueServers = Array.from(new Set(serverNumbers));

        if (!name || uniqueServers.length < 2) {
          showToast('Enter a group name and at least 2 distinct server numbers.', 'error');
          return;
        }

        const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
        if (submitBtn) submitBtn.disabled = true;
        try {
          // The group and its servers in one transaction (M4a).
          await createMigrationGroup(name, uniqueServers);

          showToast('Migration group "' + name + '" opened for servers: ' + uniqueServers.join(', '), 'success');
          if (nameInput) nameInput.value = '';
          if (serversInput) serversInput.value = '';
          await renderMigrationGroupsList();
        } catch (err: any) {
          showToast('Error creating migration group: ' + err.message, 'error');
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }
  }

  try {
    const [groupsRes, serversRes] = await Promise.all([queryMigrationGroups(db), queryMigrationGroupServers(db)]);
    if (groupsRes.error) throw groupsRes.error;

    const groups = groupsRes.data || [];
    if (groups.length === 0) {
      container.innerHTML =
        '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">No migration groups yet</div></div>';
      return;
    }

    const serversByGroup: Record<string, string[]> = {};
    (serversRes.data || []).forEach((r: any) => {
      if (!serversByGroup[r.group_id]) serversByGroup[r.group_id] = [];
      serversByGroup[r.group_id].push(r.server_number);
    });

    let html = '';
    groups.forEach((g: any) => {
      const isOpen = g.status === 'open';
      const servers = (serversByGroup[g.id] || []).slice().sort();
      const serversHtml = servers
        .map(
          (s) => '<span class="u-fs-fs-sm u-mr-4px gm-chip"><i class="ph ph-hard-drives"></i> #' + esc(s) + '</span>'
        )
        .join('');
      const statusBadge = isOpen
        ? '<span class="u-fw-700 gm-chip gm-chip-success"><i class="ph ph-lock-open"></i> Open</span>'
        : '<span class="u-bg-rgba-100-116-139-0_15 u-c-hex94a3b8 u-border-1px-solid-rgba-100-335175 u-fw-700 gm-chip"><i class="ph ph-lock"></i> Closed</span>';

      html +=
        '<div class="u-mb-0_75rem u-p-0_9rem-1_1rem gm-card glass-card">' +
        '<div class="u-d-flex u-items-center u-justify-space-between u-wrap-wrap u-gap-0_5rem">' +
        '<div class="u-d-flex u-items-center u-gap-0_6rem u-wrap-wrap">' +
        '<strong class="u-fs-fs-md">' +
        esc(g.name) +
        '</strong>' +
        statusBadge +
        '</div>' +
        '<button type="button" class="gm-btn gm-btn-sm ' +
        (isOpen ? 'gm-btn-danger' : 'gm-btn-success') +
        '" data-migration-group-id="' +
        esc(g.id) +
        '" data-migration-group-action="' +
        (isOpen ? 'close' : 'reopen') +
        '">' +
        '<i class="ph ' +
        (isOpen ? 'ph-lock' : 'ph-lock-open') +
        '"></i> <span>' +
        (isOpen ? 'Close' : 'Reopen') +
        '</span>' +
        '</button>' +
        '</div>' +
        '<div class="u-mt-0_5rem">' +
        (serversHtml || '<span class="u-fs-fs-sm u-c-text-dim">No servers linked</span>') +
        '</div>' +
        '</div>';
    });
    container.innerHTML = html;

    container.querySelectorAll('[data-migration-group-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const groupId = btn.getAttribute('data-migration-group-id') || '';
        const action = btn.getAttribute('data-migration-group-action');
        const newStatus = action === 'close' ? 'closed' : 'open';
        const confirmMsg =
          action === 'close'
            ? 'Close this migration group? Admins will no longer be able to transfer players between these servers, and any pending request made under it can no longer be approved.'
            : 'Reopen this migration group? Admins on these servers will be able to transfer players between them again.';
        showConfirm(action === 'close' ? 'Close Migration Group' : 'Reopen Migration Group', confirmMsg, async () => {
          (btn as HTMLButtonElement).disabled = true;
          try {
            const updatePayload = {
              status: newStatus,
              closed_at: newStatus === 'closed' ? new Date().toISOString() : null,
            };
            const res = await updateMigrationGroup(db, groupId, updatePayload);
            if (res.error) throw new Error(res.error.message);
            showToast('Migration group ' + (newStatus === 'closed' ? 'closed' : 'reopened') + '.', 'success');
            await renderMigrationGroupsList();
          } catch (err: any) {
            showToast('Error updating migration group: ' + err.message, 'error');
            (btn as HTMLButtonElement).disabled = false;
          }
        });
      });
    });
  } catch (err: any) {
    container.innerHTML =
      '<div class="gm-empty"><i class="u-c-danger ph ph-warning-octagon gm-icon"></i><div class="gm-empty-title">Error: ' +
      esc(err.message) +
      '</div></div>';
  }
}
