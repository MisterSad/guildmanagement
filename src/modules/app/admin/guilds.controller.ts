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

import { styleRef } from '../../../core/dom/style-refs';
import { t, esc, byId, getDb, ls } from './utils';
import { fetchGuilds } from './accounts.controller';
import { showToast, showConfirm } from '../dialogs/dialogs.service';
import { getAppState, patchAppState } from '../../../core/state/app-state';
import { openRenameGuildDialog } from './guild-rename';
import { queryGuildList, updateGuildServerNumber, deleteGuild } from './admin.service';

/** Server number the app already knows for a guild (state, then localStorage). */
function knownServerNumber(guildId: string): any {
  const entry = getAppState().guildsData[guildId];
  return (entry ? entry.server_number : '') || (ls() ? ls()!.getItem('gm_server_number_' + guildId) : '');
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
      container.innerHTML =
        '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">No guild found</div></div>';
      return;
    }

    const groupedByServer: Record<string, { serverKey: string; sNum: string; guilds: any[] }> = {};
    guildsListRaw.forEach((g: any) => {
      const guildId = g.id;
      const serverNum = g.server_number || knownServerNumber(guildId) || '';
      const sKey = serverNum ? 'Server #' + serverNum : 'Unassigned Server';
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
      const guildsListStr = group.guilds
        .map((item) => item.id)
        .sort()
        .join(', ');
      const gCount = group.guilds.length;
      const isFirst = index === 0;

      html +=
        '<div class="u-mb-1rem u-p-0 u-overflow-hidden gm-card glass-card">' +
        '<div class="u-p-0_9rem-1_2rem u-d-flex u-items-center u-justify-space-between u-cursor-pointer u-select-none u-bg-rgba-255-255-255-0_03 u-bb-1px-solid-border-soft u-transition-background-0_2s-ease gm-accordion-header">' +
        '<div class="u-d-flex u-items-center u-gap-0_75rem u-wrap-wrap">' +
        '<span class="u-bg-rgba-59-130-246-0_15 u-c-hex60a5fa u-border-1px-solid-rgba-59-b76fa4 u-rounded-6px u-p-3px-10px u-fw-800 u-fs-fs-base u-ff-font-display">' +
        '<i class="u-mr-4px ph ph-hard-drives"></i>' +
        esc(sKey) +
        '</span>' +
        '<span class="u-fw-700 u-c-fg u-fs-fs-md">' +
        esc(guildsListStr) +
        '</span>' +
        '<span class="u-bg-accent-soft u-c-accent u-fw-700 u-fs-fs-sm gm-badge">' +
        gCount +
        ' guild' +
        (gCount > 1 ? 's' : '') +
        '</span>' +
        '</div>' +
        '<i class="ph ph-caret-down gm-accordion-arrow" data-gm-style="' +
        styleRef(
          'font-size: var(--fs-xl); color:var(--fg-dim); transition:transform 0.25s ease;' +
            (isFirst ? ' transform:rotate(180deg);' : '') +
            ''
        ) +
        '"></i>' +
        '</div>' +
        '<div class="gm-accordion-body" data-gm-style="' +
        styleRef('padding:1rem 1.25rem;' + (isFirst ? ' display:block;' : ' display:none;') + '') +
        '">' +
        '<div class="gm-cred-grid">';

      group.guilds.forEach((g: any) => {
        const guildId = g.id;
        const serverNum = g.server_number || knownServerNumber(guildId) || '';

        const serverTag = serverNum
          ? ' <span class="u-fs-fs-sm u-fw-500 u-c-fg-dim">(Server #' + esc(serverNum) + ')</span>'
          : ' <span class="u-fs-fs-sm u-fw-700 gm-chip gm-chip-warning">No server number</span>';

        html +=
          '<div class="gm-cred-card" data-guild-id="' +
          esc(guildId) +
          '">' +
          '<div class="u-justify-space-between u-items-center u-mb-0_75rem gm-row">' +
          '<div class="u-fs-fs-xl u-d-flex u-items-center u-gap-0_5rem u-mb-0 u-fw-600 gm-cred-name">' +
          '<i class="ph ph-shield"></i> ' +
          esc(guildId) +
          serverTag +
          '</div>' +
          '</div>' +
          '<div class="u-gap-0_5rem u-items-center u-wrap-wrap gm-row">' +
          '<div class="u-flex-1 u-gap-0_25rem u-minw-100px gm-col">' +
          '<label class="u-fs-fs-sm u-mb-0 gm-dim">Server #</label>' +
          '<input type="text" maxlength="4" pattern="\\d{4}" class="u-p-0_25rem-0_5rem u-fs-fs-sm u-h-auto gm-input gm-input-sm guild-server-number" data-guild="' +
          esc(guildId) +
          '" aria-label="' +
          esc('Server number of ' + guildId) +
          '" value="' +
          esc(serverNum) +
          '" placeholder="e.g. 1089">' +
          '</div>' +
          '<button class="u-mt-1_15rem u-p-0_35rem-0_65rem u-fs-fs-sm u-d-flex u-items-center u-gap-0_25rem u-h-auto u-lh-1_2 gm-btn gm-btn-primary save-guild-btn" data-guild="' +
          esc(guildId) +
          '">' +
          '<i class="ph ph-floppy-disk"></i> Save' +
          '</button>' +
          '<button class="u-mt-1_15rem u-p-0_35rem-0_65rem u-fs-fs-sm u-d-flex u-items-center u-gap-0_25rem u-h-auto u-lh-1_2 gm-btn gm-btn-ghost rename-guild-btn" data-guild="' +
          esc(guildId) +
          '">' +
          '<i class="ph ph-tag"></i> Rename' +
          '</button>' +
          '<button class="u-mt-1_15rem u-p-0_35rem-0_65rem u-fs-fs-sm u-d-flex u-items-center u-gap-0_25rem u-h-auto u-lh-1_2 gm-btn gm-btn-danger-ghost delete-guild-btn" data-guild="' +
          esc(guildId) +
          '">' +
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
        const isHidden = bodyEl.style.display === 'none';
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
        if (serverNum && !/^\d{4}$/.test(serverNum)) {
          showToast('Server number must be exactly 4 digits (e.g. 1089).', 'error');
          return;
        }

        (btn as HTMLButtonElement).disabled = true;
        const origText = btn.innerHTML;
        btn.innerHTML = '<i class="ph ph-circle-notch spinner"></i>...';

        try {
          ls()?.setItem('gm_server_number_' + guildId, serverNum);
        } catch (_) {
          /* ignore */
        }
        const knownGuilds = getAppState().guildsData;
        const knownEntry = knownGuilds[guildId];
        if (knownEntry) {
          patchAppState({ guildsData: { ...knownGuilds, [guildId]: { ...knownEntry, server_number: serverNum } } });
        }

        try {
          const res = await updateGuildServerNumber(db, guildId, serverNum);
          if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
          showToast(
            'Guild ' + guildId + (serverNum ? ' (Server #' + serverNum + ')' : '') + ' updated successfully!',
            'success'
          );
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
                guildsList: st.guildsList.filter((id) => id !== guildId),
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
    container.innerHTML =
      '<div class="gm-empty"><i class="u-c-danger ph ph-warning-octagon gm-icon"></i><div class="gm-empty-title">Error: ' +
      esc(err.message) +
      '</div></div>';
  }
}
