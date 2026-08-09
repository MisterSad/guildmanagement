/**
 * scouting.js — Super admin scouting tool.
 * Track rival guild rosters over time: paste a roster (pseudo,power per line),
 * capture a snapshot, and see growth deltas per player to spot transfer
 * targets. Super admin only (the RPCs enforce is_super_admin()).
 */
(function () {

    function getDb() { return (window.GM && window.GM.db) ? window.GM.db : null; }
    var t    = window.GM ? window.GM.t  : function (k) { return k; };
    var esc  = window.GM ? window.GM.escapeHTML : function (s) { return s; };
    var fmt  = window.GM ? window.GM.formatNumber : function (n) { return String(n); };
    var big  = window.GM ? window.GM.formatPower : function (n) { return String(n); };

    var state = { guild: '', report: [], history: [], allGuilds: [] };

    window.GM_SCOUTING = { load: loadScouting, parseRoster: parseRoster };

    async function loadScouting() {
        var db = getDb();
        var area = document.querySelector('#tab-scouting .scouting-area');
        if (!db || !area) return;
        try {
            await loadGuildList();
            render(area);
        } catch (err) {
            console.error('[GM_SCOUTING] load error', err);
            area.innerHTML = '<div class="gm-empty"><div class="gm-empty-title">Failed to load scouting.</div></div>';
        }
    }

    async function loadGuildList() {
        var db = getDb();
        var res = await db.from('scouting_snapshots').select('guild');
        var set = {};
        (res.data || []).forEach(function (r) { if (r.guild) set[r.guild] = true; });
        state.allGuilds = Object.keys(set).sort();
        if (state.allGuilds.length > 0 && state.allGuilds.indexOf(state.guild) === -1) {
            state.guild = state.allGuilds[0];
        }
    }

    async function loadReport() {
        var db = getDb();
        if (!state.guild) { state.report = []; return; }
        var res = await db.rpc('gm_scouting_report', { p_guild: state.guild });
        state.report = res.data || [];
    }

    function parseRoster(text) {
        // Accepts "pseudo,power", "pseudo - power", "pseudo: power", "pseudo|power",
        // with optional quotes and thousand separators in the power.
        var rows = [];
        text.split(/\r?\n/).forEach(function (line) {
            line = line.trim();
            if (!line) return;
            // Power is numeric: capture the pseudo before the first digit field,
            // then normalize the numeric part (strip commas/dots/spaces).
            var m = line.match(/^\s*(.+?)\s*[,:\-|]\s*(\d[\d\s,.]*)\s*$/);
            if (!m) return;
            var pseudo = m[1].trim().replace(/^"|"$/g, '');
            var power = parseInt(m[2].replace(/[\s,.]/g, ''), 10);
            if (pseudo && !isNaN(power)) rows.push({ pseudo: pseudo, power: power });
        });
        return rows;
    }

    function render(area) {
        var guildOpts = state.allGuilds.map(function (g) {
            return '<option value="' + esc(g) + '"' + (g === state.guild ? ' selected' : '') + '>' + esc(g) + '</option>';
        }).join('');

        var html =
            '<div class="gm-card" style="padding:1.25rem; margin-bottom:1.25rem;">' +
                '<div class="gm-row" style="gap:.5rem; align-items:flex-end; flex-wrap:wrap;">' +
                    '<label style="display:flex; flex-direction:column; gap:.25rem; font-size:.75rem; color:var(--text-muted);">Rival guild' +
                        '<select id="scouting-guild" class="gm-select" style="width:auto; min-width:180px;">' + guildOpts + '</select></label>' +
                    '<button class="gm-btn gm-btn-primary" id="scouting-capture-btn" style="display:inline-flex; align-items:center; gap:.4rem;"><i class="ph ph-crosshair"></i> ' + (t('scouting_capture') || 'Capture roster') + '</button>' +
                '</div>' +
                '<div class="gm-row" style="gap:.5rem; align-items:flex-end; flex-wrap:wrap; margin-top:.75rem;">' +
                    '<label style="display:flex; flex-direction:column; gap:.25rem; flex:1; min-width:260px; font-size:.75rem; color:var(--text-muted);">Paste roster (pseudo,power per line)</label>' +
                '</div>' +
                '<textarea id="scouting-input" class="gm-input" rows="6" style="width:100%; margin-top:.4rem; font-family:var(--font-mono, monospace); font-size:.8rem;" placeholder="Alpha, 1000000&#10;Beta, 2000000"></textarea>' +
                '<div id="scouting-msg" class="gm-dim" style="margin-top:.5rem; font-size:.8rem;"></div>' +
            '</div>' +
            '<div class="gm-card" style="padding:1.25rem;">' +
                '<div class="gm-card-title" style="font-weight:700; margin-bottom:.75rem; display:flex; align-items:center; gap:.5rem;"><i class="ph ph-binoculars"></i> Roster report' + (state.guild ? ' — ' + esc(state.guild) : '') + '</div>' +
                '<div id="scouting-report" style="max-height:480px; overflow-y:auto;"></div>' +
            '</div>';

        area.innerHTML = html;
        wire(area);
        renderReport(area);
    }

    function renderReport(area) {
        var box = area.querySelector('#scouting-report');
        if (!box) return;
        if (state.report.length === 0) {
            box.innerHTML = '<div class="gm-empty" style="padding:2rem 1rem;"><i class="ph-duotone ph-binoculars gm-icon"></i><div class="gm-empty-title">No captured rosters yet</div><div class="gm-empty-sub">Pick a rival guild and capture a roster to start tracking growth.</div></div>';
            return;
        }
        var rows = state.report.map(function (r) {
            var delta = r.delta || 0;
            var deltaTxt = delta > 0 ? '+' + big(delta) : (delta < 0 ? big(delta) : '—');
            var deltaColor = delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--error)' : 'var(--fg-dim)');
            var when = r.last_captured ? new Date(r.last_captured).toLocaleDateString('en-GB') : '—';
            return '<div class="gm-kpi-row"><span class="gm-kpi-label" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(r.pseudo) + '</span>' +
                '<span class="gm-kpi-value" style="font-size:.72rem; color:var(--text-muted); margin-right:.5rem;">' + when + '</span>' +
                '<span class="gm-kpi-value" style="font-weight:700;">' + big(r.power) + '</span>' +
                '<span class="gm-kpi-value" style="width:80px; text-align:right; color:' + deltaColor + '; font-size:.75rem;">' + deltaTxt + '</span>' +
                '<button class="gm-btn gm-btn-ghost gm-btn-sm scouting-hist-btn" data-pseudo="' + esc(r.pseudo) + '" title="View trend" style="margin-left:.4rem;"><i class="ph ph-chart-line"></i></button>' +
            '</div>';
        }).join('');
        box.innerHTML = '<div class="gm-kpi-card"><div class="gm-kpi-card-body">' + rows + '</div></div>';
    }

    function wire(area) {
        var guildSel = area.querySelector('#scouting-guild');
        if (guildSel) {
            guildSel.addEventListener('change', async function () {
                state.guild = guildSel.value;
                await loadReport();
                renderReport(area);
            });
        }
        var captureBtn = area.querySelector('#scouting-capture-btn');
        if (captureBtn) {
            captureBtn.addEventListener('click', async function () {
                var input = area.querySelector('#scouting-input');
                var msg = area.querySelector('#scouting-msg');
                var rows = parseRoster(input.value);
                if (rows.length === 0) {
                    msg.textContent = 'Nothing parsed. Use one "pseudo, power" per line.';
                    return;
                }
                var db = getDb();
                captureBtn.disabled = true;
                captureBtn.textContent = 'Capturing...';
                try {
                    var res = await db.rpc('gm_scouting_capture', { p_guild: state.guild, p_rows: rows });
                    var data = res.data;
                    if (res.error || !data || data.ok === false) throw new Error((data && data.error) || 'capture_failed');
                    msg.textContent = 'Captured ' + data.inserted + ' players for ' + state.guild + '.';
                    input.value = '';
                    await loadGuildList();
                    await loadReport();
                    var g = area.querySelector('#scouting-guild');
                    g.innerHTML = state.allGuilds.map(function (gg) {
                        return '<option value="' + esc(gg) + '"' + (gg === state.guild ? ' selected' : '') + '>' + esc(gg) + '</option>';
                    }).join('');
                    renderReport(area);
                } catch (err) {
                    console.error('scouting capture', err);
                    msg.textContent = 'Capture failed: ' + (err.message || 'unknown error');
                } finally {
                    captureBtn.disabled = false;
                    captureBtn.textContent = 'Capture roster';
                }
            });
        }
        area.querySelectorAll('.scouting-hist-btn').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                var pseudo = btn.getAttribute('data-pseudo');
                await openHistory(pseudo);
            });
        });
    }

    async function openHistory(pseudo) {
        var db = getDb();
        var res = await db.rpc('gm_scouting_history', { p_guild: state.guild, p_pseudo: pseudo });
        var rows = res.data || [];
        if (rows.length === 0) return;
        var existing = document.getElementById('scouting-hist-modal');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'scouting-hist-modal';
        overlay.className = 'confirm-overlay';
        var bars = rows.map(function (r) {
            var when = new Date(r.captured_at).toLocaleDateString('en-GB');
            return '<div class="gm-kpi-row"><span class="gm-kpi-label">' + esc(when) + '</span>' +
                '<span class="gm-kpi-value">' + big(r.power) + '</span></div>';
        }).join('');
        overlay.innerHTML = '<div class="confirm-box" style="max-width:420px;">' +
            '<div class="confirm-title">Trend — ' + esc(pseudo) + '</div>' +
            '<div class="gm-kpi-card" style="margin-top:.75rem;"><div class="gm-kpi-card-body">' + bars + '</div></div>' +
            '<div class="confirm-actions"><button class="gm-btn gm-btn-primary" id="scouting-hist-close">Close</button></div>' +
        '</div>';
        document.body.appendChild(overlay);
        overlay.querySelector('#scouting-hist-close').addEventListener('click', function () { overlay.remove(); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    }

})();
