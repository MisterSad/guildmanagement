/**
 * benchmark.js — Super admin guild benchmark.
 * One consolidated view of every guild side by side: size, power, engagement,
 * activity and subscription, with automatic alerts (low participation, many
 * inactive, no power). Super admin only.
 */
(function () {

    function getDb() { return (window.GM && window.GM.db) ? window.GM.db : null; }
    var t   = window.GM ? window.GM.t : function (k) { return k; };
    var esc = window.GM ? window.GM.escapeHTML : function (s) { return s; };
    var fmt = window.GM ? window.GM.formatPower : function (n) { return String(n); };

    var state = { rows: [] };

    window.GM_BENCHMARK = { load: load, alertsFor: alertsFor };

    async function load() {
        var container = document.getElementById('benchmark-container');
        if (!container) return;

        if (!window.GM || !window.GM.isSuperAdmin()) {
            container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-shield-warning gm-icon"></i><div class="gm-empty-title">Super admin only</div></div>';
            return;
        }
        container.innerHTML = '<div class="gm-empty" style="padding:3rem 1rem;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading guild benchmark...</div></div>';

        var db = getDb();
        try {
            var res = await db.rpc('gm_guild_benchmark');
            if (res && res.error) throw new Error(res.error.message || 'RPC failed');
            state.rows = (res && res.data) || [];
            render(container);
        } catch (err) {
            container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-warning gm-icon"></i><div class="gm-empty-title">Failed to load benchmark</div><div class="gm-empty-sub">' + esc(err.message || '') + '</div></div>';
        }
    }

    function alertsFor(r) {
        var out = [];
        if (r.members > 0 && r.participation_rate < 40) out.push('Low participation');
        if (r.members > 0 && r.inactive_members / r.members > 0.35) out.push('Many inactive');
        if (r.max_power <= 0) out.push('No power data');
        return out;
    }

    function badge(r, text, cls) {
        return '<span class="gm-chip" style="font-size:0.68rem; padding:0.1rem 0.35rem; ' + cls + '">' + esc(text) + '</span>';
    }

    function render(container) {
        if (state.rows.length === 0) {
            container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-buildings gm-icon"></i><div class="gm-empty-title">No guilds found</div></div>';
            return;
        }

        var cards = state.rows.map(function (r) {
            var alerts = alertsFor(r);
            var alertHtml = alerts.length > 0
                ? '<div class="benchmark-alerts">' + alerts.map(function (a) { return badge(r, a, 'background:rgba(248,113,113,0.12); color:var(--error); border:1px solid rgba(248,113,113,0.3);'); }).join(' ') + '</div>'
                : '<div class="benchmark-alerts">' + badge(r, 'Healthy', 'background:rgba(52,211,153,0.12); color:var(--success); border:1px solid rgba(52,211,153,0.3);') + '</div>';

            var rateColor = r.participation_rate >= 60 ? 'var(--success)' : (r.participation_rate >= 40 ? '#fbbf24' : 'var(--error)');
            var sub = r.subscription_type || 'Standard';

            return '<div class="benchmark-card">' +
                '<div class="benchmark-card-head">' +
                    '<div class="benchmark-card-name">' + esc(r.guild) + (r.server_number ? ' <span class="gm-dim" style="font-weight:400;">(#' + esc(r.server_number) + ')</span>' : '') + '</div>' +
                    '<span class="gm-chip" style="font-size:0.68rem;">' + esc(sub) + '</span>' +
                '</div>' +
                alertHtml +
                '<div class="benchmark-card-stats">' +
                    '<div class="benchmark-stat"><div class="benchmark-stat-value">' + r.members + '</div><div class="benchmark-stat-label">Members</div></div>' +
                    '<div class="benchmark-stat"><div class="benchmark-stat-value">' + fmt(r.total_power) + '</div><div class="benchmark-stat-label">Total power</div></div>' +
                    '<div class="benchmark-stat"><div class="benchmark-stat-value">' + fmt(r.max_power) + '</div><div class="benchmark-stat-label">Max player</div></div>' +
                    '<div class="benchmark-stat"><div class="benchmark-stat-value" style="color:' + rateColor + ';">' + r.participation_rate + '%</div><div class="benchmark-stat-label">Participation (8w)</div></div>' +
                    '<div class="benchmark-stat"><div class="benchmark-stat-value">' + r.active_events + '</div><div class="benchmark-stat-label">Active events</div></div>' +
                    '<div class="benchmark-stat"><div class="benchmark-stat-value">' + r.inactive_members + '</div><div class="benchmark-stat-label">Inactive (2w)</div></div>' +
                '</div>' +
            '</div>';
        }).join('');

        container.innerHTML =
            '<div class="gm-row" style="justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:.5rem;">' +
                '<div class="gm-page-subtitle" style="margin:0;">' + state.rows.length + ' guilds compared</div>' +
                '<button class="gm-btn gm-btn-ghost gm-btn-sm" id="benchmark-refresh" style="display:inline-flex; align-items:center; gap:.4rem;"><i class="ph ph-arrows-clockwise"></i> Refresh</button>' +
            '</div>' +
            '<div class="benchmark-grid">' + cards + '</div>';

        var refresh = container.querySelector('#benchmark-refresh');
        if (refresh) refresh.addEventListener('click', load);
    }

})();
