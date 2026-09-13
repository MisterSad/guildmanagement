/**
 * src/modules/app/admin/migration-groups.controller.ts
 *
 * Sous-lot 6.5 (Strangler) — cross-server migration groups panel ported from
 * app.js#renderMigrationGroupsList (super-admin create/open/close/reopen).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { esc, winAny, byId, getDb } from './utils';
import { showToast } from '../dialogs/dialogs.service';

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
        const serverNumbers = serversInput ? serversInput.value.split(',').map((s) => s.trim()).filter(Boolean) : [];
        const uniqueServers = Array.from(new Set(serverNumbers));

        if (!name || uniqueServers.length < 2) {
          showToast('Enter a group name and at least 2 distinct server numbers.', 'error');
          return;
        }

        const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
        if (submitBtn) submitBtn.disabled = true;
        try {
          const groupRes = await db.from('server_migration_groups').insert([{ name, status: 'open' }]).select('id').single();
          if (groupRes.error) throw new Error(groupRes.error.message);

          const groupId = groupRes.data.id;
          const linkRes = await db.from('server_migration_group_servers')
            .insert(uniqueServers.map((s) => ({ group_id: groupId, server_number: s })));
          if (linkRes.error) throw new Error(linkRes.error.message);

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
    const [groupsRes, serversRes] = await Promise.all([
      db.from('server_migration_groups').select('id, name, status').order('created_at', { ascending: false }),
      db.from('server_migration_group_servers').select('group_id, server_number')
    ]);
    if (groupsRes.error) throw groupsRes.error;

    const groups = groupsRes.data || [];
    if (groups.length === 0) {
      container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">No migration groups yet</div></div>';
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
      const serversHtml = servers.map((s) =>
        '<span class="gm-chip" style="font-size: var(--fs-sm); margin-right:4px;"><i class="ph ph-hard-drives"></i> #' + esc(s) + '</span>'
      ).join('');
      const statusBadge = isOpen
        ? '<span class="gm-chip gm-chip-success" style="font-weight:700;"><i class="ph ph-lock-open"></i> Open</span>'
        : '<span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3); font-weight:700;"><i class="ph ph-lock"></i> Closed</span>';

      html +=
        '<div class="gm-card glass-card" style="margin-bottom:0.75rem; padding:0.9rem 1.1rem;">' +
          '<div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">' +
            '<div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">' +
              '<strong style="font-size: var(--fs-md);">' + esc(g.name) + '</strong>' +
              statusBadge +
            '</div>' +
            '<button type="button" class="gm-btn gm-btn-sm ' + (isOpen ? 'gm-btn-danger' : 'gm-btn-success') + '" data-migration-group-id="' + esc(g.id) + '" data-migration-group-action="' + (isOpen ? 'close' : 'reopen') + '">' +
              '<i class="ph ' + (isOpen ? 'ph-lock' : 'ph-lock-open') + '"></i> <span>' + (isOpen ? 'Close' : 'Reopen') + '</span>' +
            '</button>' +
          '</div>' +
          '<div style="margin-top:0.5rem;">' + (serversHtml || '<span style="font-size: var(--fs-sm); color:var(--text-dim);">No servers linked</span>') + '</div>' +
        '</div>';
    });
    container.innerHTML = html;

    container.querySelectorAll('[data-migration-group-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const groupId = btn.getAttribute('data-migration-group-id') || '';
        const action = btn.getAttribute('data-migration-group-action');
        const newStatus = action === 'close' ? 'closed' : 'open';
        const confirmMsg = action === 'close'
          ? 'Close this migration group? Admins will no longer be able to transfer players between these servers, and any pending request made under it can no longer be approved.'
          : 'Reopen this migration group? Admins on these servers will be able to transfer players between them again.';
        const w = winAny();
        if (!w.showConfirm) return;
        w.showConfirm(action === 'close' ? 'Close Migration Group' : 'Reopen Migration Group', confirmMsg, async () => {
          (btn as HTMLButtonElement).disabled = true;
          try {
            const updatePayload = { status: newStatus, closed_at: newStatus === 'closed' ? new Date().toISOString() : null };
            const res = await db.from('server_migration_groups').update(updatePayload).eq('id', groupId);
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
    container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-warning-octagon gm-icon" style="color:var(--danger);"></i><div class="gm-empty-title">Error: ' + esc(err.message) + '</div></div>';
  }
}
