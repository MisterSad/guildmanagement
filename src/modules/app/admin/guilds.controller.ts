/**
 * src/modules/app/admin/guilds.controller.ts
 *
 * Super-admin guild roster: guilds grouped by game server, with the server
 * number editor, guild rename (guild-rename.ts) and guild deletion.
 *
 * Phase 1 (payment removal) renamed this from `subscriptions.controller.ts`.
 * Only the subscription fields were dead -- the tab itself is live and is the
 * *only* surface that assigns a guild's `server_number` (a prerequisite for
 * cross-server transfers, see members.controller#showTransferMemberDialog)
 * and the only one that deletes a guild via `gm_delete_guild`. Deleting the
 * file, as the audit roadmap first proposed, would have removed both.
 *
 * The removed subscription editor also carried a latent bug: it offered a
 * 'Lifetime' option that `guilds_subscription_type_check` never accepted, so
 * choosing it failed the save.
 */


import { t, esc, byId, getDb, ls } from './utils';
import { fetchGuilds } from './accounts.controller';
import { showToast, showConfirm } from '../dialogs/dialogs.service';
import { getAppState, patchAppState } from '../../../core/state/app-state';
import { openRenameGuildDialog } from './guild-rename';
import { queryGuildList, updateGuildServerNumber, deleteGuild } from './admin.service';

/** Server number the app already knows for a guild (state, then localStorage). */
function knownServerNumber(guildId: string): any {
  const entry = getAppState().guildsData[guildId];
  return (entry ? entry.server_number : '')
    || (ls() ? ls()!.getItem('gm_server_number_' + guildId) : '');
}

export async function renderGuildsList(): Promise<void> {
  const container = byId('guilds-list-container');
  const db = getDb();
  if (!container || !db) return;

  try {
    const res = await queryGuildList(db);
    if (res.error) throw res.error;
    const guildsListRaw = res.data;
    if (!guildsListRaw || guildsListRaw.length === 0) {
      container.innerHTML = '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">No guild found</div></div>';
      return;
    }

    const groupedByServer: Record<string, { serverKey: string; sNum: string; guilds: any[] }> = {};
    guildsListRaw.forEach((g: any) => {
      const guildId = g.id;
      const serverNum = g.server_number || knownServerNumber(guildId) || '';
      const sKey = serverNum ? ('Server #' + serverNum) : 'Unassigned Server';
      if (!groupedByServer[sKey]) groupedByServer[sKey] = { serverKey: sKey, sNum: serverNum, guilds: [] };
      groupedByServer[sKey].guilds.push(g);
    });

    const serverKeys = Object.keys(groupedByServer).sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ''), 10) || 999999;
      const numB = parseInt(b.replace(/\D/g, ''), 10) || 999999;
      if (numA !== numB) return numA - numB;
      return a.localeCompare(b);
    });

    let html = '';
    serverKeys.forEach((sKey, index) => {
      const group = groupedByServer[sKey];
      const guildsListStr = group.guilds.map((item) => item.id).sort().join(', ');
      const gCount = group.guilds.length;
      const isFirst = index === 0;

      html +=
        '<div class="gm-card glass-card" style="margin-bottom:1rem; padding:0; overflow:hidden;">' +
          '<div class="gm-accordion-header" style="padding:0.9rem 1.2rem; display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-soft); transition:background 0.2s ease;">' +
            '<div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap;">' +
              '<span style="background:rgba(59, 130, 246, 0.15); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.3); border-radius:6px; padding:3px 10px; font-weight:800; font-size: var(--fs-base); font-family:var(--font-display);">' +
                '<i class="ph ph-hard-drives" style="margin-right:4px;"></i>' + esc(sKey) +
              '</span>' +
              '<span style="font-weight:700; color:var(--fg); font-size: var(--fs-md);">' + esc(guildsListStr) + '</span>' +
              '<span class="gm-badge" style="background:var(--accent-soft); color:var(--accent); font-weight:700; font-size: var(--fs-sm);">' + gCount + ' guild' + (gCount > 1 ? 's' : '') + '</span>' +
            '</div>' +
            '<i class="ph ph-caret-down gm-accordion-arrow" style="font-size: var(--fs-xl); color:var(--fg-dim); transition:transform 0.25s ease;' + (isFirst ? ' transform:rotate(180deg);' : '') + '"></i>' +
          '</div>' +
          '<div class="gm-accordion-body" style="padding:1rem 1.25rem;' + (isFirst ? ' display:block;' : ' display:none;') + '">' +
            '<div class="gm-cred-grid">';

      group.guilds.forEach((g: any) => {
        const guildId = g.id;
        const serverNum = g.server_number || knownServerNumber(guildId) || '';

        const serverTag = serverNum
          ? ' <span style="font-size: var(--fs-sm); font-weight:500; color:var(--fg-dim);">(Server #' + esc(serverNum) + ')</span>'
          : ' <span class="gm-chip gm-chip-warning" style="font-size: var(--fs-sm); font-weight:700;">No server number</span>';

        html +=
          '<div class="gm-cred-card" data-guild-id="' + esc(guildId) + '">' +
            '<div class="gm-row" style="justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">' +
              '<div class="gm-cred-name" style="font-size: var(--fs-xl); display: flex; align-items: center; gap: 0.5rem; margin-bottom:0; font-weight:600;">' +
                '<i class="ph ph-shield"></i> ' + esc(guildId) + serverTag +
              '</div>' +
            '</div>' +
            '<div class="gm-row" style="gap: 0.5rem; align-items: center; flex-wrap: wrap;">' +
              '<div class="gm-col" style="flex: 1; gap: 0.25rem; min-width:100px;">' +
                '<label class="gm-dim" style="font-size: var(--fs-sm); margin-bottom:0;">Server #</label>' +
                '<input type="text" maxlength="4" pattern="\\d{4}" class="gm-input gm-input-sm guild-server-number" data-guild="' + esc(guildId) + '" aria-label="' + esc('Server number of ' + guildId) + '" value="' + esc(serverNum) + '" style="padding: 0.25rem 0.5rem; font-size: var(--fs-sm); height: auto;" placeholder="e.g. 1089">' +
              '</div>' +
              '<button class="gm-btn gm-btn-primary save-guild-btn" data-guild="' + esc(guildId) + '" style="margin-top: 1.15rem; padding: 0.35rem 0.65rem; font-size: var(--fs-sm); display:flex; align-items:center; gap:0.25rem; height: auto; line-height: 1.2;">' +
                '<i class="ph ph-floppy-disk"></i> Save' +
              '</button>' +
              '<button class="gm-btn gm-btn-ghost rename-guild-btn" data-guild="' + esc(guildId) + '" style="margin-top: 1.15rem; padding: 0.35rem 0.65rem; font-size: var(--fs-sm); display:flex; align-items:center; gap:0.25rem; height: auto; line-height: 1.2;">' +
                '<i class="ph ph-tag"></i> Rename' +
              '</button>' +
              '<button class="gm-btn gm-btn-danger-ghost delete-guild-btn" data-guild="' + esc(guildId) + '" style="margin-top: 1.15rem; padding: 0.35rem 0.65rem; font-size: var(--fs-sm); display:flex; align-items:center; gap:0.25rem; height: auto; line-height: 1.2;">' +
                '<i class="ph ph-trash"></i> Delete' +
              '</button>' +
            '</div>' +
          '</div>';
      });

      html += '</div></div></div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('.gm-accordion-header').forEach((headerEl) => {
      headerEl.addEventListener('click', () => {
        const bodyEl = headerEl.nextElementSibling as HTMLElement | null;
        const arrowEl = headerEl.querySelector('.gm-accordion-arrow') as HTMLElement | null;
        if (!bodyEl) return;
        const isHidden = (bodyEl.style.display === 'none');
        if (isHidden) {
          bodyEl.style.display = 'block';
          if (arrowEl) arrowEl.style.transform = 'rotate(180deg)';
        } else {
          bodyEl.style.display = 'none';
          if (arrowEl) arrowEl.style.transform = 'rotate(0deg)';
        }
      });
    });

    container.querySelectorAll('.save-guild-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const guildId = btn.getAttribute('data-guild') || '';
        const card = container.querySelector('.gm-cred-card[data-guild-id="' + guildId + '"]');
        if (!card) return;
        const serverNumInput = card.querySelector('.guild-server-number') as HTMLInputElement | null;
        const serverNum = serverNumInput ? serverNumInput.value.trim() : '';
        if (serverNum && !/^\d{4}$/.test(serverNum)) { showToast('Server number must be exactly 4 digits (e.g. 1089).', 'error'); return; }

        (btn as HTMLButtonElement).disabled = true;
        const origText = btn.innerHTML;
        btn.innerHTML = '<i class="ph ph-circle-notch spinner"></i>...';

        try { ls()?.setItem('gm_server_number_' + guildId, serverNum); } catch (_) { /* ignore */ }
        const knownGuilds = getAppState().guildsData;
        const knownEntry = knownGuilds[guildId];
        if (knownEntry) {
          patchAppState({ guildsData: { ...knownGuilds, [guildId]: { ...knownEntry, server_number: serverNum } } });
        }

        try {
          const res = await updateGuildServerNumber(db, guildId, serverNum);
          if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
          showToast('Guild ' + guildId + (serverNum ? ' (Server #' + serverNum + ')' : '') + ' updated successfully!', 'success');
          await fetchGuilds();
          await renderGuildsList();
        } catch (err: any) {
          showToast('Error during update: ' + err.message, 'error');
        } finally {
          (btn as HTMLButtonElement).disabled = false;
          btn.innerHTML = origText;
        }
      });
    });

    container.querySelectorAll('.rename-guild-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const guildId = btn.getAttribute('data-guild') || '';
        // Renaming the active guild reloads the page (applyRenameToSession);
        // any other guild only needs the roster and the selects refreshed.
        openRenameGuildDialog(guildId, async () => {
          await fetchGuilds();
          await renderGuildsList();
        });
      });
    });

    container.querySelectorAll('.delete-guild-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const guildId = btn.getAttribute('data-guild') || '';
        showConfirm(
          t('confirm_delete_guild_title'),
          t('confirm_delete_guild_body') + ' <strong>' + esc(guildId) + '</strong>' + t('confirm_delete_guild_body2'),
          async () => {
            (btn as HTMLButtonElement).disabled = true;
            const origText = btn.innerHTML;
            btn.innerHTML = '<i class="ph ph-circle-notch spinner"></i>...';
            try {
              const rpcRes = await deleteGuild(db, guildId);
              if (rpcRes.error) throw new Error(rpcRes.error.message || JSON.stringify(rpcRes.error));
              const row = (Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data) || {};
              if (!row.ok) throw new Error(row.error || 'Failed to delete guild');

              ls()?.removeItem('gm_server_number_' + guildId);
              const st = getAppState();
              const remainingData = { ...st.guildsData };
              delete remainingData[guildId];
              patchAppState({
                guildsData: remainingData,
                guildsList: st.guildsList.filter((id) => id !== guildId)
              });
              showToast('Guild ' + guildId + ' deleted successfully', 'success');
              await fetchGuilds();
              await renderGuildsList();
            } catch (err: any) {
              showToast('Error deleting guild: ' + err.message, 'error');
              (btn as HTMLButtonElement).disabled = false;
              btn.innerHTML = origText;
            }
          }
        );
      });
    });
  } catch (err: any) {
    container.innerHTML = '<div class="gm-empty"><i class="ph ph-warning-octagon gm-icon" style="color:var(--danger);"></i><div class="gm-empty-title">Error: ' + esc(err.message) + '</div></div>';
  }
}
