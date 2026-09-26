/**
 * src/modules/app/admin/subscriptions.controller.ts
 *
 * Sous-lot 6.5 (Strangler) — super-admin guild subscription list ported from
 * app.js#renderGuildsSubscriptionList (accordion by server, type/end/server
 * editor, save + delete via RPC).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { t, esc, winAny, byId, getDb, ls } from './utils';
import { fetchGuilds } from './accounts.controller';
import { showToast } from '../dialogs/dialogs.service';

export async function renderGuildsSubscriptionList(): Promise<void> {
  const container = byId('guilds-list-container');
  const db = getDb();
  if (!container || !db) return;
  const w = winAny();

  try {
    const res = await db.from('guilds').select('id, subscription_type, subscription_end, server_number').order('id');
    if (res.error) throw res.error;
    const guildsListRaw = res.data;
    if (!guildsListRaw || guildsListRaw.length === 0) {
      container.innerHTML = '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">No guild found</div></div>';
      return;
    }

    const groupedByServer: Record<string, { serverKey: string; sNum: string; guilds: any[] }> = {};
    guildsListRaw.forEach((g: any) => {
      const guildId = g.id;
      const serverNum = g.server_number
        || (w.guildsData && w.guildsData[guildId] ? w.guildsData[guildId].server_number : '')
        || (ls() ? ls()!.getItem('gm_server_number_' + guildId) : '')
        || '';
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
        const type = g.subscription_type || 'Unlimited';
        const end = g.subscription_end;
        const serverNum = g.server_number
          || (w.guildsData && w.guildsData[guildId] ? w.guildsData[guildId].server_number : '')
          || (ls() ? ls()!.getItem('gm_server_number_' + guildId) : '')
          || '';
        const dateVal = end ? end.split('T')[0] : '';

        let countdownHtml = '';
        if (type === 'Unlimited') {
          countdownHtml = '<span class="gm-chip gm-chip-success" style="font-size: var(--fs-sm); font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;"><i class="ph ph-infinity"></i> Unlimited</span>';
        } else if (type === 'Lifetime') {
          countdownHtml = '<span class="gm-chip gm-chip-success" style="font-size: var(--fs-sm); font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;"><i class="ph ph-infinity"></i> Lifetime</span>';
        } else if (end) {
          const diff = new Date(end).getTime() - Date.now();
          if (diff <= 0) {
            countdownHtml = '<span class="gm-chip gm-chip-danger" style="font-size: var(--fs-sm); font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;"><i class="ph ph-lock-key"></i> Expired</span>';
          } else {
            const secs = Math.floor(diff / 1000);
            const mins = Math.floor(secs / 60);
            const hours = Math.floor(mins / 60);
            const days = Math.floor(hours / 24);
            let timeStr = '';
            if (days > 0) timeStr = days + 'd ' + (hours % 24) + 'h';
            else if (hours > 0) timeStr = hours + 'h ' + (mins % 60) + 'm';
            else timeStr = mins + 'm';
            countdownHtml = '<span class="gm-chip gm-chip-warning" style="font-size: var(--fs-sm); font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;"><i class="ph ph-clock"></i> ' + timeStr + ' remaining</span>';
          }
        } else {
          countdownHtml = '<span class="gm-chip gm-chip-danger" style="font-size: var(--fs-sm); font-weight: 700;">No date (Expired)</span>';
        }

        const serverTag = serverNum ? ' <span style="font-size: var(--fs-sm); font-weight:500; color:var(--fg-dim);">(Server #' + esc(serverNum) + ')</span>' : '';

        html +=
          '<div class="gm-cred-card" data-guild-id="' + esc(guildId) + '">' +
            '<div class="gm-row" style="justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">' +
              '<div class="gm-cred-name" style="font-size: var(--fs-xl); display: flex; align-items: center; gap: 0.5rem; margin-bottom:0; font-weight:600;">' +
                '<i class="ph ph-shield"></i> ' + esc(guildId) + serverTag +
              '</div>' +
              '<div class="countdown-badge-wrapper">' + countdownHtml + '</div>' +
            '</div>' +
            '<div class="gm-row" style="gap: 0.5rem; align-items: center; flex-wrap: wrap;">' +
              '<div class="gm-col" style="flex: 1; gap: 0.25rem; min-width:100px;">' +
                '<label class="gm-dim" style="font-size: var(--fs-sm); margin-bottom:0;">Server #</label>' +
                '<input type="text" maxlength="4" pattern="\\d{4}" class="gm-input gm-input-sm guild-server-number" data-guild="' + esc(guildId) + '" value="' + esc(serverNum) + '" style="padding: 0.25rem 0.5rem; font-size: var(--fs-sm); height: auto;" placeholder="e.g. 1089">' +
              '</div>' +
              '<div class="gm-col" style="flex: 1.2; gap: 0.25rem; min-width:110px;">' +
                '<label class="gm-dim" style="font-size: var(--fs-sm); margin-bottom:0;">Type</label>' +
                '<select class="gm-select gm-select-sm guild-sub-type" data-guild="' + esc(guildId) + '" style="padding: 0.25rem 0.5rem; font-size: var(--fs-sm); height: auto;">' +
                  '<option value="Unlimited"' + (type === 'Unlimited' ? ' selected' : '') + '>Unlimited</option>' +
                  '<option value="Premium"' + (type === 'Premium' ? ' selected' : '') + '>Premium</option>' +
                  '<option value="Lifetime"' + (type === 'Lifetime' ? ' selected' : '') + '>Lifetime</option>' +
                '</select>' +
              '</div>' +
              '<div class="gm-col guild-sub-end-wrapper" style="flex: 1.2; gap: 0.25rem; min-width:110px; ' + (type !== 'Premium' ? 'display: none;' : '') + '">' +
                '<label class="gm-dim" style="font-size: var(--fs-sm); margin-bottom:0;">End Date</label>' +
                '<input type="date" class="gm-input gm-input-sm guild-sub-end" data-guild="' + esc(guildId) + '" value="' + dateVal + '" style="padding: 0.25rem 0.5rem; font-size: var(--fs-sm); height: auto;">' +
              '</div>' +
              '<button class="gm-btn gm-btn-primary save-guild-sub-btn" data-guild="' + esc(guildId) + '" style="margin-top: 1.15rem; padding: 0.35rem 0.65rem; font-size: var(--fs-sm); display:flex; align-items:center; gap:0.25rem; height: auto; line-height: 1.2;">' +
                '<i class="ph ph-floppy-disk"></i> Save' +
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

    container.querySelectorAll('.guild-sub-type').forEach((select) => {
      select.addEventListener('change', () => {
        const guildId = select.getAttribute('data-guild');
        const wrapper = container.querySelector('.gm-cred-card[data-guild-id="' + guildId + '"] .guild-sub-end-wrapper') as HTMLElement | null;
        if (wrapper) wrapper.style.display = (select as HTMLSelectElement).value === 'Premium' ? '' : 'none';
      });
    });

    container.querySelectorAll('.save-guild-sub-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const guildId = btn.getAttribute('data-guild') || '';
        const card = container.querySelector('.gm-cred-card[data-guild-id="' + guildId + '"]');
        if (!card) return;
        const select = card.querySelector('.guild-sub-type') as HTMLSelectElement;
        const input = card.querySelector('.guild-sub-end') as HTMLInputElement;
        const serverNumInput = card.querySelector('.guild-server-number') as HTMLInputElement | null;
        const type = select.value;
        let endVal: string | null = null;
        if (type === 'Premium') {
          if (!input.value) { showToast('Please specify an end date for Premium subscription.', 'error'); return; }
          endVal = new Date(input.value + 'T23:59:59Z').toISOString();
        }
        const serverNum = serverNumInput ? serverNumInput.value.trim() : '';
        if (serverNum && !/^\d{4}$/.test(serverNum)) { showToast('Server number must be exactly 4 digits (e.g. 1089).', 'error'); return; }

        (btn as HTMLButtonElement).disabled = true;
        const origText = btn.innerHTML;
        btn.innerHTML = '<i class="ph ph-circle-notch spinner"></i>...';

        try { ls()?.setItem('gm_server_number_' + guildId, serverNum); } catch (_) { /* ignore */ }
        if (w.guildsData && w.guildsData[guildId]) {
          w.guildsData[guildId].server_number = serverNum;
          w.guildsData[guildId].type = type;
          w.guildsData[guildId].end = endVal;
        }

        try {
          const updatePayload = { subscription_type: type, subscription_end: endVal, server_number: serverNum || null };
          const res = await db.from('guilds').update(updatePayload).eq('id', guildId).select();
          if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
          showToast('Guild ' + guildId + (serverNum ? ' (Server #' + serverNum + ')' : '') + ' updated successfully!', 'success');
          await fetchGuilds();
          await renderGuildsSubscriptionList();
        } catch (err: any) {
          showToast('Error during update: ' + err.message, 'error');
        } finally {
          (btn as HTMLButtonElement).disabled = false;
          btn.innerHTML = origText;
        }
      });
    });

    container.querySelectorAll('.delete-guild-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const guildId = btn.getAttribute('data-guild') || '';
        if (!w.showConfirm) return;
        w.showConfirm(
          t('confirm_delete_guild_title'),
          t('confirm_delete_guild_body') + ' <strong>' + esc(guildId) + '</strong>' + t('confirm_delete_guild_body2'),
          async () => {
            (btn as HTMLButtonElement).disabled = true;
            const origText = btn.innerHTML;
            btn.innerHTML = '<i class="ph ph-circle-notch spinner"></i>...';
            try {
              const rpcRes = await db.rpc('gm_delete_guild', { p_guild_id: guildId });
              if (rpcRes.error) throw new Error(rpcRes.error.message || JSON.stringify(rpcRes.error));
              const row = (Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data) || {};
              if (!row.ok) throw new Error(row.error || 'Failed to delete guild');

              ls()?.removeItem('gm_server_number_' + guildId);
              if (w.guildsData) delete w.guildsData[guildId];
              if (w.guildsList) {
                const idx = w.guildsList.indexOf(guildId);
                if (idx !== -1) w.guildsList.splice(idx, 1);
              }
              showToast('Guild ' + guildId + ' deleted successfully', 'success');
              await fetchGuilds();
              await renderGuildsSubscriptionList();
              if (typeof w.populateGuildSelects === 'function') w.populateGuildSelects();
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
