/**
 * tickets.js — Super Admin bug-ticket console.
 * Lists every bug report (from any guild) and lets the super admin set
 * status (open / resolved / closed). Loads on demand via window.GM_TICKETS.
 */
(function () {

    var esc = window.GM ? window.GM.escapeHTML : function (s) { return s; };
    var t = window.GM ? window.GM.t : function (k) { return k; };
    var fmt = window.GM ? window.GM.formatNumber : function (n) { return String(n); };

    var SEVERITY_CLASS = {
        low:      'gm-chip',
        medium:   'gm-chip',
        high:     'gm-chip',
        critical: 'gm-chip'
    };
    var SEVERITY_COLOR = {
        low:      'background:rgba(148,163,184,0.14); color:#94a3b8; border:1px solid rgba(148,163,184,0.3);',
        medium:   'background:rgba(245,158,11,0.14); color:#fbbf24; border:1px solid rgba(245,158,11,0.3);',
        high:     'background:rgba(249,115,22,0.14); color:#fb923c; border:1px solid rgba(249,115,22,0.3);',
        critical: 'background:rgba(239,68,68,0.14); color:#f87171; border:1px solid rgba(239,68,68,0.3);'
    };
    var STATUS_LABEL = {
        open:     'tickets_status_open',
        resolved: 'tickets_status_resolved',
        closed:   'tickets_status_closed'
    };
    var STATUS_CLASS = {
        open:     'gm-chip',
        resolved: 'gm-chip',
        closed:   'gm-chip'
    };
    var CATEGORY = { bug: 'ticket_cat_bug', feature: 'ticket_cat_feature', other: 'ticket_cat_other' };

    function getDb() { return (window.GM && window.GM.db) ? window.GM.db : null; }

    function pad(n) { return String(n).padStart(4, '0'); }

    function statusChip(status) {
        var label = STATUS_LABEL[status] ? t(STATUS_LABEL[status]) : status;
        var bg = status === 'open'
            ? 'background:rgba(59,130,246,0.14); color:#60a5fa; border:1px solid rgba(59,130,246,0.3);'
            : status === 'resolved'
                ? 'background:rgba(16,185,129,0.14); color:#34d399; border:1px solid rgba(16,185,129,0.3);'
                : 'background:rgba(100,116,139,0.14); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);';
        return '<span class="' + STATUS_CLASS[status] + '" style="font-size:0.72rem; font-weight:700; padding:2px 9px; border-radius:9999px; ' + bg + ';">' + esc(label) + '</span>';
    }

    function severityChip(sev) {
        var label = sev.charAt(0).toUpperCase() + sev.slice(1);
        var bg = SEVERITY_COLOR[sev] || SEVERITY_COLOR.medium;
        return '<span class="gm-chip" style="font-size:0.72rem; font-weight:700; padding:2px 9px; border-radius:9999px; ' + bg + ';">' + esc(label) + '</span>';
    }

    function loadingHtml() {
        return '<div class="gm-empty" style="padding:2.5rem 1rem;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading tickets...</div></div>';
    }

    async function load() {
        var container = document.getElementById('tickets-container');
        if (!container) return;
        var db = getDb();
        if (!db || !db.functions) {
            container.innerHTML = loadingHtml();
            return;
        }
        if (!window.GM || !window.GM.isSuperAdmin()) {
            container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-shield-warning gm-icon"></i><div class="gm-empty-title">Super admin only</div></div>';
            return;
        }

        container.innerHTML = loadingHtml();
        try {
            var res = await db.functions.invoke('tickets', { body: { action: 'list' } });
            var data = res && res.data;
            if (!data || !data.ok) throw new Error((data && data.error) || 'list_failed');
            render(container, data.tickets || []);
        } catch (err) {
            console.error('tickets load error', err);
            container.innerHTML =
                '<div class="gm-empty">' +
                    '<i class="ph-duotone ph-warning-circle gm-icon"></i>' +
                    '<div class="gm-empty-title">Could not load tickets</div>' +
                    '<button class="gm-btn gm-btn-outline" onclick="if(window.GM_TICKETS)window.GM_TICKETS.load()"><i class="ph ph-arrows-clockwise"></i> Retry</button>' +
                '</div>';
        }
    }

    function render(container, tickets) {
        if (!tickets || tickets.length === 0) {
            container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ticket gm-icon"></i><div class="gm-empty-title">' + esc(t('tickets_empty')) + '</div></div>';
            return;
        }

        var html =
            '<div class="gm-table-wrap" style="background:var(--bg-1); border:1px solid var(--border-soft); border-radius:var(--radius-lg); overflow-x:auto;">' +
                '<table class="gm-table gm-resp-table" style="width:100%; border-collapse:collapse; min-width:820px;">' +
                    '<thead><tr style="background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-soft); font-size:0.72rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted);">' +
                        '<th style="padding:0.65rem 0.75rem; text-align:left;">#</th>' +
                        '<th style="padding:0.65rem 0.5rem; text-align:left;">' + esc(t('tickets_reporter')) + '</th>' +
                        '<th style="padding:0.65rem 0.5rem; text-align:left;">' + esc(t('tickets_category')) + '</th>' +
                        '<th style="padding:0.65rem 0.5rem; text-align:center;">' + esc(t('tickets_severity')) + '</th>' +
                        '<th style="padding:0.65rem 0.5rem; text-align:center;">Status</th>' +
                        '<th style="padding:0.65rem 0.75rem; text-align:left;">Title</th>' +
                        '<th style="padding:0.65rem 0.5rem; text-align:left;">' + esc(t('tickets_date')) + '</th>' +
                        '<th style="padding:0.65rem 0.75rem; text-align:center;">Set status</th>' +
                    '</tr></thead><tbody>';

        tickets.forEach(function (tk) {
            var cat = CATEGORY[tk.category] ? t(CATEGORY[tk.category]) : (tk.category || '');
            var guildLabel = tk.guild ? esc(tk.guild) : 'Global';
            var dateStr = tk.created_at ? new Date(tk.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
            var rawDesc = tk.description || '';
            var desc = esc(rawDesc).replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--fg); font-weight:700; display:inline-block; margin-top:0.25rem;">$1</strong>');

            var attachHtml = '';
            if (Array.isArray(tk.attachments) && tk.attachments.length > 0) {
                attachHtml = '<div style="display:flex; flex-wrap:wrap; gap:0.4rem; margin-top:0.45rem;">';
                tk.attachments.forEach(function (attUrl) {
                    attachHtml += '<img src="' + esc(attUrl) + '" class="gm-ticket-thumb" data-full="' + esc(attUrl) + '" style="width:54px; height:42px; object-fit:cover; border-radius:4px; border:1px solid var(--border-soft); cursor:pointer; transition:transform 0.15s;" title="Click to view screenshot" onmouseover="this.style.transform=\'scale(1.08)\'" onmouseout="this.style.transform=\'scale(1)\'">';
                });
                attachHtml += '</div>';
            }

            html +=
                '<tr style="border-bottom:1px solid var(--border-soft); vertical-align:top;">' +
                    '<td data-label="#" style="padding:0.65rem 0.75rem; font-weight:700; font-variant-numeric:tabular-nums;">#TICKET-' + pad(tk.ticket_number) + '</td>' +
                    '<td data-label="' + esc(t('tickets_reporter')) + '" style="padding:0.65rem 0.5rem;">' +
                        '<div style="font-weight:600; font-size:0.85rem;">' + esc(tk.reporter_account_id) + '</div>' +
                        '<div style="font-size:0.7rem; color:var(--text-muted);">' + esc(tk.reporter_role) + ' · ' + guildLabel + '</div>' +
                    '</td>' +
                    '<td data-label="' + esc(t('tickets_category')) + '" style="padding:0.65rem 0.5rem; font-size:0.82rem;">' + esc(cat) + '</td>' +
                    '<td data-label="' + esc(t('tickets_severity')) + '" style="padding:0.65rem 0.5rem; text-align:center;">' + severityChip(tk.severity) + '</td>' +
                    '<td data-label="Status" style="padding:0.65rem 0.5rem; text-align:center;">' + statusChip(tk.status) + '</td>' +
                    '<td data-label="Title" style="padding:0.65rem 0.5rem; min-width:260px;">' +
                        '<div style="font-weight:700; font-size:0.92rem; color:var(--fg);">' + esc(tk.title) + '</div>' +
                        (desc ? '<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.35rem; line-height:1.45; white-space:pre-wrap; background:rgba(0,0,0,0.18); padding:0.5rem 0.65rem; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">' + desc + '</div>' : '') +
                        attachHtml +
                    '</td>' +
                    '<td data-label="' + esc(t('tickets_date')) + '" style="padding:0.65rem 0.5rem; font-size:0.78rem; color:var(--text-muted); white-space:nowrap;">' + esc(dateStr) + '</td>' +
                    '<td data-label="' + esc(t('tickets_set')) + '" style="padding:0.65rem 0.75rem; text-align:center;">' +
                        '<select class="gm-select gm-select-sm gm-ticket-status" data-id="' + tk.id + '" data-ticket-no="' + tk.ticket_number + '" style="font-size:0.75rem; padding:0.15rem 0.4rem; height:auto; width:auto; min-width:90px; border-radius:4px;">' +
                            '<option value="open"' + (tk.status === 'open' ? ' selected' : '') + '>' + esc(t('tickets_status_open')) + '</option>' +
                            '<option value="resolved"' + (tk.status === 'resolved' ? ' selected' : '') + '>' + esc(t('tickets_status_resolved')) + '</option>' +
                            '<option value="closed"' + (tk.status === 'closed' ? ' selected' : '') + '>' + esc(t('tickets_status_closed')) + '</option>' +
                        '</select>' +
                    '</td>' +
                '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;

        container.querySelectorAll('.gm-ticket-status').forEach(function (sel) {
            sel.addEventListener('change', function () {
                updateStatus(sel.getAttribute('data-id'), sel.value, sel);
            });
        });

        container.querySelectorAll('.gm-ticket-thumb').forEach(function (img) {
            img.addEventListener('click', function () {
                openLightbox(img.getAttribute('data-full'));
            });
        });
    }

    function openLightbox(src) {
        if (!src) return;
        var modal = document.createElement('div');
        modal.className = 'gm-modal-overlay visible';
        modal.style.zIndex = '9999';
        modal.innerHTML =
            '<div style="position:relative; max-width:92vw; max-height:92vh; display:flex; flex-direction:column; align-items:center;">' +
                '<button type="button" class="gm-btn gm-btn-ghost gm-btn-icon" style="position:absolute; top:-38px; right:0; color:#fff; font-size:1.4rem;" title="Close">✕</button>' +
                '<img src="' + esc(src) + '" style="max-width:100%; max-height:85vh; object-fit:contain; border-radius:8px; box-shadow:0 8px 30px rgba(0,0,0,0.8); border:1px solid rgba(255,255,255,0.1);">' +
            '</div>';
        document.body.appendChild(modal);
        function close() { if (modal && modal.parentNode) modal.parentNode.removeChild(modal); }
        modal.addEventListener('click', close);
    }

    async function updateStatus(id, status, sel) {
        var db = getDb();
        if (!db || !db.functions) return;
        var original = sel.value;
        sel.disabled = true;
        try {
            var res = await db.functions.invoke('tickets', { body: { action: 'update-status', id: Number(id), status: status } });
            var data = res && res.data;
            if (!data || !data.ok) throw new Error((data && data.error) || 'update_failed');
            if (window.GM.showToast) window.GM.showToast('Ticket updated', 'success');
            await load();
        } catch (err) {
            console.error('ticket status update error', err);
            sel.value = original;
            if (window.GM.showToast) window.GM.showToast('Could not update ticket', 'error');
        } finally {
            sel.disabled = false;
        }
    }

    window.GM_TICKETS = { load: load };

})();
