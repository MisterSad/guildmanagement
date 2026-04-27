/**
 * glory.js — Weekly glory tracker with real-time evolution vs previous week
 * Stores in event_participants (event_name = 'Glory').
 * Displays delta (▲/▼) in real-time as the admin types.
 */
(function () {

    var SUPABASE_URL = 'https://vgweufzwmfwplusskmuf.supabase.co';
    var SUPABASE_KEY = 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo';
    var db;
    try { db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch (e) { console.error('glory.js init', e); }

    function t(k) { return window.RAD_I18N ? window.RAD_I18N.t(k) : k; }
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;'); }

    function getWeekStart() {
        var d = new Date();
        var day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        var diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday-based
        var monday = new Date(d.getFullYear(), d.getMonth(), diff);
        var mm = String(monday.getMonth() + 1).padStart(2, '0');
        var dd = String(monday.getDate()).padStart(2, '0');
        return monday.getFullYear() + '-' + mm + '-' + dd;
    }

    function getPrevWeekStart() {
        var d = new Date(getWeekStart() + 'T12:00:00');
        d.setDate(d.getDate() - 7);
        return d.toISOString().split('T')[0];
    }

    window.RAD_GLORY = { load: loadGlory };

    // ── Load current + previous week glory ────────────────────────────────────
    async function loadGlory() {
        if (!db) return;
        var week     = getWeekStart();
        var prevWeek = getPrevWeekStart();

        var [membersRes, currRes, prevRes] = await Promise.all([
            db.from('guild_members').select('pseudo').order('pseudo', { ascending: true }),
            db.from('event_participants').select('pseudo,score').eq('event_name', 'Glory').eq('week_start', week),
            db.from('event_participants').select('pseudo,score').eq('event_name', 'Glory').eq('week_start', prevWeek)
        ]);

        var members  = (membersRes.data || []).map(function (m) { return m.pseudo; });
        var currMap  = {};
        var prevMap  = {};
        (currRes.data  || []).forEach(function (r) { currMap[r.pseudo] = r.score; });
        (prevRes.data  || []).forEach(function (r) { prevMap[r.pseudo] = r.score; });

        // Ensure participant rows exist for current week
        var existing = new Set(Object.keys(currMap));
        var toInsert = members
            .filter(function (p) { return !existing.has(p); })
            .map(function (p) { return { event_name: 'Glory', week_start: week, pseudo: p, participated: 1, score: null }; });
        
        if (toInsert.length > 0) {
            await db.from('event_participants').insert(toInsert);
            // Add inserted members to currMap so they appear in initial render
            toInsert.forEach(function(item) { currMap[item.pseudo] = null; });
        }

        renderGlory(members, currMap, prevMap, week);
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function renderGlory(members, currMap, prevMap, week) {
        var area = document.querySelector('#event-glory .event-participants-area');
        if (!area) return;

        if (!members.length) {
            area.innerHTML = '<div class="empty-state"><i class="ph-duotone ph-ghost"></i><p>' + t('empty_members') + '</p></div>';
            return;
        }

        var totalGlory = Object.values(currMap).reduce(function (s, v) { return s + (v || 0); }, 0);
        var hasPrev    = Object.keys(prevMap).length > 0;

        var html =
            '<div class="event-stats">' +
                '<span class="stat-chip"><i class="ph-fill ph-users"></i> ' + members.length + ' ' + t('event_total') + '</span>' +
                '<span class="stat-chip accent"><i class="ph-fill ph-trophy"></i> ' + t('glory_total') + ' <span class="total-glory-val">' + totalGlory + '</span></span>' +
                (hasPrev ? '<span class="stat-chip muted"><i class="ph-fill ph-clock-counter-clockwise"></i> ' + t('glory_vs_prev') + '</span>' : '') +
            '</div>' +
            '<div class="event-search-bar">' +
                '<input type="text" class="glory-search-input" placeholder="' + t('search_placeholder') + '">' +
            '</div>' +
            '<div class="participants-table-wrap">' +
            '<table class="participants-table"><thead><tr>' +
                '<th>' + t('col_member') + '</th>' +
                '<th class="center">' + t('glory_prev_week') + '</th>' +
                '<th class="center">' + t('glory_this_week') + '</th>' +
                '<th class="center">' + t('glory_input') + '</th>' +
                '<th class="center">' + t('glory_evolution_pct') + '</th>' +
            '</tr></thead><tbody>';

        members.forEach(function (pseudo) {
            var curr = currMap[pseudo] != null ? currMap[pseudo] : '';
            var prev = prevMap[pseudo] != null ? prevMap[pseudo] : null;

            html +=
                '<tr class="participant-row" data-pseudo="' + esc(pseudo) + '">' +
                    '<td class="pseudo-cell"><i class="ph-fill ph-game-controller text-accent"></i> ' + esc(pseudo) + '</td>' +
                    '<td class="center glory-prev-val">' +
                        (prev !== null ? '<span class="glory-prev">' + prev + '</span>' : '<span class="glory-na">—</span>') +
                    '</td>' +
                    '<td class="center glory-curr-val">' +
                        (curr !== '' ? '<span>' + curr + '</span>' : '<span class="glory-na">—</span>') +
                    '</td>' +
                    '<td class="score-cell">' +
                        '<div class="glory-input-wrapper">' +
                            '<input type="number" min="0" class="score-input glory-input"' +
                                ' value="' + curr + '" placeholder="0"' +
                                ' data-pseudo="' + esc(pseudo) + '"' +
                                ' data-prev="' + (prev !== null ? prev : '') + '">' +
                            '<i class="ph ph-circle-notch ph-spin saving-icon hidden"></i>' +
                        '</div>' +
                    '</td>' +
                    '<td class="center glory-pct-cell">' +
                        buildEvolutionPctBadge(curr, prev) +
                    '</td>' +
                '</tr>';
        });

        html += '</tbody></table></div>';
        area.innerHTML = html;

        // Search logic
        var searchInput = area.querySelector('.glory-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', function (e) {
                var q = e.target.value.toLowerCase();
                area.querySelectorAll('.participant-row').forEach(function (row) {
                    var pseudo = row.getAttribute('data-pseudo').toLowerCase();
                    row.style.display = (pseudo.indexOf(q) !== -1) ? '' : 'none';
                });
            });
        }

        // Real-time delta + debounced save
        area.querySelectorAll('.glory-input').forEach(function (inp) {
            var timer;
            inp.addEventListener('input', function () {
                var prev  = inp.getAttribute('data-prev');
                var curr  = inp.value;
                var row   = inp.closest('tr');

                // Update "This Week" display cell
                var currCell = row.querySelector('.glory-curr-val');
                if (currCell) {
                    currCell.innerHTML = curr !== '' ? '<span>' + curr + '</span>' : '<span class="glory-na">—</span>';
                }

                // Update Evolution % cell
                var pctCell = row.querySelector('.glory-pct-cell');
                if (pctCell) {
                    pctCell.innerHTML = buildEvolutionPctBadge(curr, prev === '' ? null : parseInt(prev, 10));
                }

                // Update total chip
                updateTotal(area);

                // Show saving icon
                var icon = row.querySelector('.saving-icon');
                if (icon) icon.classList.remove('hidden');

                // Debounced save
                clearTimeout(timer);
                timer = setTimeout(function () {
                    saveGlory(inp.getAttribute('data-pseudo'), inp.value, week, icon);
                }, 700);
            });
        });
    }

    // ── Evolution % badge HTML ────────────────────────────────────────────────
    function buildEvolutionPctBadge(curr, prev) {
        if (curr === '' || prev === null || prev === 0) return '<span class="glory-na">—</span>';
        var c = parseInt(curr, 10);
        var p = parseInt(prev, 10);
        var diff = c - p;
        var pct = (diff / p) * 100;
        
        var cls = 'neutral';
        if (pct > 0) cls = 'positive';
        else if (pct < 0) cls = 'negative';

        var sign = pct > 0 ? '+' : '';
        return '<span class="glory-delta ' + cls + '">' + sign + pct.toFixed(1) + '%</span>';
    }

    // ── Update total stat-chip in real time ───────────────────────────────────
    function updateTotal(area) {
        var total = 0;
        area.querySelectorAll('.glory-input').forEach(function (inp) {
            total += (parseInt(inp.value, 10) || 0);
        });
        var valSpan = area.querySelector('.total-glory-val');
        if (valSpan) valSpan.textContent = total;
    }

    // ── Save ─────────────────────────────────────────────────────────────────
    async function saveGlory(pseudo, value, week, icon) {
        if (!db) return;
        try {
            var scoreVal = value === '' ? null : parseInt(value, 10);
            var { error } = await db.from('event_participants')
                .upsert({ 
                    event_name: 'Glory', 
                    week_start: week, 
                    pseudo: pseudo, 
                    score: scoreVal,
                    participated: 1 
                }, { onConflict: 'event_name,week_start,pseudo' });

            if (error) throw error;
            
            // Success: hide icon
            if (icon) icon.classList.add('hidden');
        } catch (err) {
            console.error('saveGlory error', err);
            if (icon) icon.classList.add('hidden');
            if (window.RAD_APP) window.RAD_APP.showToast(t('toast_err_generic') || 'Error saving glory', 'error');
        }
    }

})();

