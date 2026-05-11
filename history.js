/**
 * history.js — Historique complet des sessions d'événements.
 * Liste agrégée via RPC list_event_sessions, détail par session via SELECT.
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t  : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };
    var fmt = window.RAD ? window.RAD.formatNumber : function (n) { return String(n); };

    var EVENT_META = {
        'SvS':                { icon: 'ph-sword',       label: 'SvS',         filterKey: 'SvS',         hasScore: true,  border: 'var(--accent)' },
        'GvG':                { icon: 'ph-flag-banner', label: 'GvG',         filterKey: 'GvG',         hasScore: true,  border: 'var(--accent)' },
        'Shadowfront':        { icon: 'ph-ghost',       label: 'Shadowfront', filterKey: 'Shadowfront', hasScore: false, border: 'var(--info)'   },
        'Defend Trade Route': { icon: 'ph-rocket',      label: 'DTR',         filterKey: 'DTR',         hasScore: false, border: 'var(--info)'   },
        'ARMS RACE STAGE A':  { icon: 'ph-target',      label: 'Arms Race A', filterKey: 'Arms Race',   hasScore: false, border: 'var(--warning)'},
        'ARMS RACE STAGE B':  { icon: 'ph-target',      label: 'Arms Race B', filterKey: 'Arms Race',   hasScore: false, border: 'var(--warning)'},
        'Glory':              { icon: 'ph-trophy',      label: 'Glory',       filterKey: 'Glory',       hasScore: true,  border: 'var(--success)'}
    };

    var FILTERS = ['All', 'SvS', 'GvG', 'Shadowfront', 'DTR', 'Arms Race', 'Glory'];

    var sessions = [];
    var activeFilter = 'All';

    window.RAD_HISTORY = { load: loadHistory };

    async function loadHistory() {
        if (!db) return;
        var res = await db.rpc('list_event_sessions');
        if (res.error) {
            console.error('list_event_sessions', res.error);
            window.RAD.showToast(t('toast_err_generic') + ' ' + res.error.message, 'error');
            return;
        }
        sessions = res.data || [];
        renderHistory();
    }

    function renderHistory() {
        var area = document.querySelector('#event-history .history-area');
        if (!area) return;

        var pillsHtml = '<div class="gm-row" style="gap:.5rem; flex-wrap:wrap; margin-bottom:1rem;">' +
            FILTERS.map(function (f) {
                var isActive = (f === activeFilter);
                var label = (f === 'All') ? t('history_filter_all') : f;
                return '<button class="gm-chip history-filter' + (isActive ? ' gm-chip-accent active' : '') + '" data-filter="' + esc(f) + '">' + esc(label) + '</button>';
            }).join('') + '</div>';

        var filtered = sessions.filter(function (s) {
            if (activeFilter === 'All') return true;
            var meta = EVENT_META[s.event_name];
            return meta && meta.filterKey === activeFilter;
        });

        if (filtered.length === 0) {
            area.innerHTML = pillsHtml +
                '<div class="gm-empty"><i class="ph-duotone ph-clock-counter-clockwise gm-icon"></i><div class="gm-empty-title">' + t('history_empty') + '</div></div>';
            wirePills();
            return;
        }

        var cardsHtml = '<div class="gm-history-list">';
        filtered.forEach(function (s) {
            var meta    = EVENT_META[s.event_name] || { icon: 'ph-circle', label: s.event_name, hasScore: false, border: 'var(--border-soft)' };
            var when    = formatWhen(s.session_id, s.week_start);
            var weekStr = window.RAD.formatWeek(s.week_start);
            var ratio   = s.participants > 0 ? Math.round((s.participated_count / s.participants) * 100) : 0;
            cardsHtml +=
                '<div class="gm-history-card" data-event="' + esc(s.event_name) + '" data-session="' + esc(s.session_id || '') + '" data-week="' + esc(s.week_start) + '" style="border-left-color:' + meta.border + ';">' +
                    '<div class="gm-history-head">' +
                        '<div class="gm-history-icon" style="color:' + meta.border + ';"><i class="ph-fill ' + meta.icon + '"></i></div>' +
                        '<div class="gm-grow gm-truncate">' +
                            '<div class="gm-history-title">' + esc(meta.label) + '</div>' +
                            '<div class="gm-history-when gm-dim">' + esc(when) + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="gm-history-chips">' +
                        '<span class="gm-chip"><i class="ph ph-calendar-blank"></i> ' + esc(weekStr) + '</span>' +
                        '<span class="gm-chip"><i class="ph-fill ph-users"></i> ' + s.participants + '</span>' +
                        '<span class="gm-chip gm-chip-success"><i class="ph-fill ph-check-circle"></i> ' + s.participated_count + ' (' + ratio + '%)</span>' +
                        (s.total_score > 0 ? '<span class="gm-chip gm-chip-accent"><i class="ph-fill ph-trophy"></i> ' + fmt(s.total_score) + '</span>' : '') +
                    '</div>' +
                '</div>';
        });
        cardsHtml += '</div>';

        area.innerHTML = pillsHtml + cardsHtml;
        wirePills();
        wireCards();
    }

    function formatWhen(sessionId, weekStart) {
        if (sessionId) {
            return new Date(sessionId).toLocaleDateString('fr-FR', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
        }
        return t('history_week_only');
    }

    function wirePills() {
        document.querySelectorAll('#event-history .history-filter').forEach(function (btn) {
            btn.addEventListener('click', function () {
                activeFilter = btn.getAttribute('data-filter');
                renderHistory();
            });
        });
    }

    function wireCards() {
        document.querySelectorAll('#event-history .gm-history-card').forEach(function (card) {
            card.addEventListener('click', function () {
                var ev   = card.getAttribute('data-event');
                var sid  = card.getAttribute('data-session') || null;
                var week = card.getAttribute('data-week');
                openSessionDetail(ev, sid, week);
            });
        });
    }

    async function openSessionDetail(eventName, sessionId, weekStart) {
        var meta = EVENT_META[eventName] || { label: eventName, icon: 'ph-circle', hasScore: false, border: 'var(--border-soft)' };

        var query = db.from('event_participants')
            .select('pseudo, participated, score, score_prep, score_pvp')
            .eq('event_name', eventName)
            .eq('week_start', weekStart)
            .limit(100000);

        if (sessionId) {
            query = query.eq('session_id', sessionId);
        } else {
            query = query.is('session_id', null);
        }

        var res = await query;
        if (res.error) {
            window.RAD.showToast(t('toast_err_generic') + ' ' + res.error.message, 'error');
            return;
        }

        var rows = res.data || [];
        var isSvsNew = (eventName === 'SvS') && rows.some(function (r) { return r.score_prep != null || r.score_pvp != null; });
        renderSessionModal(eventName, sessionId, weekStart, rows, meta, isSvsNew);
    }

    function renderSessionModal(eventName, sessionId, weekStart, rows, meta, isSvsNew) {
        var existing = document.getElementById('history-modal');
        if (existing) existing.remove();

        var when = sessionId
            ? new Date(sessionId).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
            : t('history_week_only');

        var sorted = rows.slice().sort(function (a, b) {
            var ap = a.participated || 0, bp = b.participated || 0;
            if (bp !== ap) return bp - ap;
            var as = (a.score || 0) + (a.score_prep || 0) + (a.score_pvp || 0);
            var bs = (b.score || 0) + (b.score_prep || 0) + (b.score_pvp || 0);
            if (bs !== as) return bs - as;
            return String(a.pseudo).localeCompare(String(b.pseudo));
        });

        var headerCols =
            '<th>' + t('col_member') + '</th>' +
            '<th class="gm-center">' + t('col_participated') + '</th>' +
            (isSvsNew
                ? '<th class="gm-right">' + t('col_score_prep') + '</th><th class="gm-right">' + t('col_score_pvp') + '</th>'
                : (meta.hasScore ? '<th class="gm-right">' + t('col_score') + '</th>' : ''));

        var rowsHtml = sorted.map(function (r) {
            var initial = window.RAD.avatarInit(r.pseudo);
            var participatedCell = r.participated > 0
                ? '<i class="ph-fill ph-check-circle text-success"></i>'
                : '<i class="ph ph-x-circle gm-dim"></i>';
            var scoreCells = isSvsNew
                ? '<td class="gm-right">' + (r.score_prep != null ? fmt(r.score_prep) : '—') + '</td>' +
                  '<td class="gm-right">' + (r.score_pvp  != null ? fmt(r.score_pvp)  : '—') + '</td>'
                : (meta.hasScore
                    ? '<td class="gm-right">' + (r.score != null ? fmt(r.score) : '—') + '</td>'
                    : '');
            return '<tr>' +
                '<td><div class="gm-row" style="gap:.5rem;"><div class="gm-avatar">' + esc(initial) + '</div><strong>' + esc(r.pseudo) + '</strong></div></td>' +
                '<td class="gm-center">' + participatedCell + '</td>' +
                scoreCells +
                '</tr>';
        }).join('');

        var totalScore = sorted.reduce(function (s, r) { return s + (r.score || 0) + (r.score_prep || 0) + (r.score_pvp || 0); }, 0);
        var doneCount  = sorted.reduce(function (s, r) { return s + (r.participated > 0 ? 1 : 0); }, 0);

        var overlay = document.createElement('div');
        overlay.id = 'history-modal';
        overlay.className = 'confirm-overlay';
        overlay.innerHTML =
            '<div class="confirm-card glass-card" style="max-width: 760px; width: 95vw;">' +
                '<div class="gm-row" style="justify-content:space-between; align-items:flex-start; margin-bottom:1rem;">' +
                    '<div>' +
                        '<h3 style="margin:0;"><i class="ph-fill ' + meta.icon + '" style="color:' + meta.border + ';"></i> ' + esc(meta.label) + '</h3>' +
                        '<div class="gm-dim" style="margin-top:.25rem; font-size:.85rem;">' + esc(when) + ' · ' + esc(window.RAD.formatWeek(weekStart)) + '</div>' +
                    '</div>' +
                    '<button class="gm-btn gm-btn-ghost gm-btn-icon" id="history-modal-close" title="' + t('close_title') + '"><i class="ph ph-x"></i></button>' +
                '</div>' +
                '<div class="gm-row" style="gap:.5rem; flex-wrap:wrap; margin-bottom:1rem;">' +
                    '<span class="gm-chip"><i class="ph-fill ph-users"></i> ' + sorted.length + '</span>' +
                    '<span class="gm-chip gm-chip-success"><i class="ph-fill ph-check-circle"></i> ' + doneCount + ' ' + t('event_participated') + '</span>' +
                    (totalScore > 0 ? '<span class="gm-chip gm-chip-accent"><i class="ph-fill ph-trophy"></i> ' + fmt(totalScore) + '</span>' : '') +
                '</div>' +
                (sorted.length === 0
                    ? '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('history_empty_session') + '</div></div>'
                    : '<div class="gm-table-wrap"><div class="gm-table-scroll" style="max-height: 60vh;">' +
                        '<table class="gm-table gm-resp-table">' +
                            '<thead><tr>' + headerCols + '</tr></thead>' +
                            '<tbody>' + rowsHtml + '</tbody>' +
                        '</table>' +
                      '</div></div>') +
            '</div>';
        document.body.appendChild(overlay);
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        function close() {
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 300);
        }
        document.getElementById('history-modal-close').addEventListener('click', close);
        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    }

})();
