/**
 * stats.js — Weekly leaderboard, /20 score computation, member profile history
 * Score formula:  participation (16pts) + glory normalized (4pts) = /20
 */
(function () {

    var SUPABASE_URL = 'https://vgweufzwmfwplusskmuf.supabase.co';
    var SUPABASE_KEY = 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo';
    var db;
    try { db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch (e) { console.error('stats.js init', e); }

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

    function formatWeek(ws) {
        var d = new Date(ws + 'T12:00:00');
        var end = new Date(d); end.setDate(end.getDate() + 6);
        var fmt = { day: '2-digit', month: '2-digit' };
        return d.toLocaleDateString('fr-FR', fmt) + ' → ' + end.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    // ── State ──────────────────────────────────────────────────────────────────
    var currentWeek    = getWeekStart();
    var allWeeks       = [];
    var leaderboardData = [];

    // ── Public API ──────────────────────────────────────────────────────────────
    window.RAD_STATS = { load: loadStats };

    // ── Entry point ─────────────────────────────────────────────────────────────
    async function loadStats() {
        if (!db) return;
        await fetchAllWeeks();
        renderControls();
        await loadLeaderboard(currentWeek);
    }

    // ── Fetch all weeks that have data ───────────────────────────────────────────
    async function fetchAllWeeks() {
        var res = await db.from('event_participants').select('week_start');
        var weeks = [];
        if (res.data) weeks = Array.from(new Set(res.data.map(function (r) { return r.week_start; })));
        weeks.sort(function (a, b) { return b.localeCompare(a); });
        if (weeks.indexOf(currentWeek) === -1) weeks.unshift(currentWeek);
        allWeeks = weeks;
    }

    // ── Load leaderboard (from cache or compute) ─────────────────────────────────
    async function loadLeaderboard(week) {
        var cached = await db.from('weekly_scores').select('*').eq('week_start', week).order('score_20', { ascending: false }).order('pseudo', { ascending: true });
        if (cached.data && cached.data.length > 0) {
            leaderboardData = cached.data;
            renderLeaderboard();
        } else {
            await computeAndSave(week);
        }
    }

    // ── Compute /20 scores and persist ──────────────────────────────────────────
    async function computeAndSave(week) {
        if (!db) return;

        var [membersRes, partsRes] = await Promise.all([
            db.from('guild_members').select('pseudo'),
            db.from('event_participants').select('*').eq('week_start', week)
        ]);

        var members     = (membersRes.data || []).map(function (m) { return m.pseudo; });
        var participants = partsRes.data || [];

        if (members.length === 0) { renderEmptyStats(); return; }

        // Non-Glory events that were active (i.e. have at least one participant row)
        var nonGloryEvents = Array.from(new Set(
            participants.filter(function (p) { return p.event_name !== 'Glory'; }).map(function (p) { return p.event_name; })
        ));
        var eventsTotal = nonGloryEvents.length;

        // Glory data
        var gloryRows  = participants.filter(function (p) { return p.event_name === 'Glory'; });
        var maxGlory   = gloryRows.reduce(function (mx, r) { return Math.max(mx, r.score || 0); }, 0);

        var scores = members.map(function (pseudo) {
            // Participation score
            var memberNonGlory = participants.filter(function (p) { return p.pseudo === pseudo && p.event_name !== 'Glory'; });
            var eventsDone = memberNonGlory.reduce(function (s, p) { return s + (p.participated || 0); }, 0);
            var participationScore = eventsTotal > 0 ? (eventsDone / eventsTotal) * 16 : 0;

            // Glory score
            var gloryRow   = gloryRows.find(function (r) { return r.pseudo === pseudo; });
            var gloryScore = gloryRow ? (gloryRow.score || 0) : 0;
            var gloryNorm  = maxGlory > 0 ? (gloryScore / maxGlory) * 4 : 0;

            var total = Math.round((participationScore + gloryNorm) * 10) / 10;
            return { week_start: week, pseudo: pseudo, score_20: total, events_done: eventsDone, events_total: eventsTotal, glory_score: gloryScore, computed_at: new Date().toISOString() };
        });

        await db.from('weekly_scores').upsert(scores, { onConflict: 'week_start,pseudo' });
        leaderboardData = scores.slice().sort(function (a, b) {
            if (b.score_20 !== a.score_20) return b.score_20 - a.score_20;
            return a.pseudo.localeCompare(b.pseudo);
        });
        renderLeaderboard();
    }

    // ── Render week selector + compute button ────────────────────────────────────
    function renderControls() {
        document.querySelectorAll('.stats-controls').forEach(function (el) {
            var optHtml = allWeeks.map(function (w) {
                return '<option value="' + w + '"' + (w === currentWeek ? ' selected' : '') + '>' + formatWeek(w) + '</option>';
            }).join('');
            el.innerHTML =
                '<div class="stats-controls-inner">' +
                    '<select class="week-select">' + optHtml + '</select>' +
                    '<button class="btn-compute">' +
                        '<i class="ph ph-arrows-clockwise"></i> ' + t('stats_compute') +
                    '</button>' +
                '</div>';

            el.querySelector('.week-select').addEventListener('change', function () {
                currentWeek = this.value;
                loadLeaderboard(currentWeek);
            });
            el.querySelector('.btn-compute').addEventListener('click', function () {
                computeAndSave(currentWeek);
            });
        });
    }

    // ── Render leaderboard ───────────────────────────────────────────────────────
    function renderLeaderboard() {
        document.querySelectorAll('.stats-leaderboard-area').forEach(function (container) {
            if (!leaderboardData.length) {
                container.innerHTML = '<div class="empty-state"><i class="ph-duotone ph-chart-bar"></i><p>' + t('stats_no_data') + '</p></div>';
                return;
            }

            /* ── Podium ── */
            var top = leaderboardData.slice(0, Math.min(3, leaderboardData.length));
            // Reorder: 2nd, 1st, 3rd for visual podium
            var podOrder = top.length >= 3 ? [top[1], top[0], top[2]]
                         : top.length === 2 ? [top[1], top[0]]
                         : [top[0]];
            var medals = { 0: '🥇', 1: '🥈', 2: '🥉' };
            var heights = { 0: 90, 1: 120, 2: 70 }; // bar height px

            var podHtml = '<div class="stats-podium">';
            podOrder.forEach(function (m, i) {
                var orig = leaderboardData.indexOf(m); // 0-based rank
                podHtml +=
                    '<div class="podium-slot rank-' + (orig + 1) + '" data-pseudo="' + esc(m.pseudo) + '">' +
                        '<div class="podium-medal">' + (medals[orig] || '') + '</div>' +
                        '<div class="podium-name">' + esc(m.pseudo) + '</div>' +
                        '<div class="podium-score-val">' + parseFloat(m.score_20).toFixed(1) + '/20</div>' +
                        '<div class="podium-bar" style="height:' + heights[i] + 'px">' +
                            '<div class="podium-bar-fill" style="height:' + heights[i] + 'px"></div>' +
                        '</div>' +
                    '</div>';
            });
            podHtml += '</div>';

            /* ── Full Table ── */
            var tableHtml =
                '<div class="leaderboard-wrap">' +
                '<table class="leaderboard-table"><thead><tr>' +
                    '<th>#</th>' +
                    '<th>' + t('col_member') + '</th>' +
                    '<th class="center">' + t('stats_score') + '</th>' +
                    '<th class="center">' + t('stats_events') + '</th>' +
                    '<th class="center">Glory</th>' +
                    '<th class="center">' + t('stats_profile') + '</th>' +
                '</tr></thead><tbody>';

            leaderboardData.forEach(function (m, i) {
                var rank = i + 1;
                var badge = rank <= 3 ? medals[i] : '#' + rank;
                var s = parseFloat(m.score_20);
                var cls = s >= 16 ? 'score-high' : s >= 10 ? 'score-mid' : 'score-low';
                tableHtml +=
                    '<tr class="lb-row">' +
                        '<td class="rank-cell">' + badge + '</td>' +
                        '<td class="pseudo-cell"><i class="ph-fill ph-game-controller text-accent"></i> ' + esc(m.pseudo) + '</td>' +
                        '<td class="center"><span class="score-badge ' + cls + '">' + s.toFixed(1) + '/20</span></td>' +
                        '<td class="center">' + m.events_done + '/' + m.events_total + '</td>' +
                        '<td class="center">' + (m.glory_score || 0) + '</td>' +
                        '<td class="center">' +
                            '<button class="profile-btn" data-pseudo="' + esc(m.pseudo) + '" title="' + t('stats_see_profile') + '">' +
                                '<i class="ph ph-chart-line-up"></i>' +
                            '</button>' +
                        '</td>' +
                    '</tr>';
            });
            tableHtml += '</tbody></table></div>';

            container.innerHTML = podHtml + tableHtml;

            container.querySelectorAll('.profile-btn, .podium-slot').forEach(function (btn) {
                btn.addEventListener('click', function () { openProfile(btn.getAttribute('data-pseudo')); });
            });
        });
    }

    function renderEmptyStats() {
        document.querySelectorAll('.stats-leaderboard-area').forEach(function (el) {
            el.innerHTML = '<div class="empty-state"><i class="ph-duotone ph-chart-bar"></i><p>' + t('stats_no_data') + '</p></div>';
        });
    }

    // ── Member Profile Modal ─────────────────────────────────────────────────────
    async function openProfile(pseudo) {
        var res = await db.from('weekly_scores').select('*').eq('pseudo', pseudo).order('week_start', { ascending: true });
        var history = res.data || [];

        var existing = document.getElementById('profile-modal');
        if (existing) existing.remove();

        var avg  = history.length ? (history.reduce(function (s, r) { return s + parseFloat(r.score_20); }, 0) / history.length).toFixed(1) : '—';
        var best = history.length ? Math.max.apply(null, history.map(function (r) { return parseFloat(r.score_20); })).toFixed(1) : '—';
        var trend = history.length >= 2
            ? (parseFloat(history[history.length-1].score_20) - parseFloat(history[history.length-2].score_20)).toFixed(1)
            : null;
        var trendHtml = trend !== null
            ? '<span class="stat-chip ' + (parseFloat(trend) >= 0 ? 'success' : 'muted') + '">' +
              (parseFloat(trend) >= 0 ? '↑' : '↓') + ' ' + Math.abs(trend) + '</span>'
            : '';

        var modal = document.createElement('div');
        modal.id = 'profile-modal';
        modal.className = 'confirm-overlay';

        var html =
            '<div class="profile-card glass-card">' +
                '<div class="profile-header">' +
                    '<div class="profile-avatar"><i class="ph-fill ph-user-circle"></i></div>' +
                    '<div class="profile-info">' +
                        '<h2 class="text-gradient">' + esc(pseudo) + '</h2>' +
                        '<div class="profile-meta-row">' +
                            '<span class="stat-chip accent"><i class="ph-fill ph-trophy"></i> Moy. ' + avg + '/20</span>' +
                            '<span class="stat-chip success"><i class="ph-fill ph-star"></i> Best ' + best + '/20</span>' +
                            '<span class="stat-chip"><i class="ph-fill ph-calendar"></i> ' + history.length + ' sem.</span>' +
                            trendHtml +
                        '</div>' +
                    '</div>' +
                    '<button class="icon-btn profile-close" title="Fermer"><i class="ph ph-x"></i></button>' +
                '</div>';

        // Sparkline chart
        if (history.length >= 2) {
            html += '<div class="profile-sparkline">' + buildSparkline(history.map(function (r) { return parseFloat(r.score_20); }), history.map(function (r) { return r.week_start; })) + '</div>';
        }

        // History table
        html +=
            '<div class="profile-history">' +
            '<table class="leaderboard-table"><thead><tr>' +
                '<th>' + t('stats_week') + '</th>' +
                '<th class="center">' + t('stats_score') + '</th>' +
                '<th class="center">' + t('stats_events') + '</th>' +
                '<th class="center">Glory</th>' +
            '</tr></thead><tbody>';

        history.slice().reverse().forEach(function (row) {
            var s = parseFloat(row.score_20);
            var cls = s >= 16 ? 'score-high' : s >= 10 ? 'score-mid' : 'score-low';
            html +=
                '<tr><td class="week-cell">' + formatWeek(row.week_start) + '</td>' +
                '<td class="center"><span class="score-badge ' + cls + '">' + s.toFixed(1) + '/20</span></td>' +
                '<td class="center">' + row.events_done + '/' + row.events_total + '</td>' +
                '<td class="center">' + (row.glory_score || 0) + '</td></tr>';
        });

        html += '</tbody></table></div></div>';
        modal.innerHTML = html;
        document.body.appendChild(modal);
        requestAnimationFrame(function () { modal.classList.add('visible'); });

        modal.querySelector('.profile-close').addEventListener('click', function () { closeModal(modal); });
        modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(modal); });
    }

    function closeModal(modal) {
        modal.classList.remove('visible');
        setTimeout(function () { modal.remove(); }, 300);
    }

    // ── SVG Sparkline ────────────────────────────────────────────────────────────
    function buildSparkline(scores, weeks) {
        var W = 500, H = 100, px = 16, py = 12;
        var n = scores.length;
        var pts = scores.map(function (s, i) {
            var x = px + (i / (n - 1)) * (W - px * 2);
            var y = H - py - (s / 20) * (H - py * 2);
            return [x.toFixed(1), y.toFixed(1)];
        });

        var line  = pts.map(function (p) { return p.join(','); }).join(' ');
        var area  = (px + ',' + (H - py) + ' ') + line + (' ' + (W - px) + ',' + (H - py));
        var dots  = pts.map(function (p, i) {
            var cls = i === n - 1 ? 'sp-dot sp-dot-last' : 'sp-dot';
            return '<circle class="' + cls + '" cx="' + p[0] + '" cy="' + p[1] + '" r="4"/>';
        }).join('');

        // Y-axis labels (0, 10, 20)
        var yLines = [0, 10, 20].map(function (v) {
            var y = H - py - (v / 20) * (H - py * 2);
            return '<line x1="' + px + '" x2="' + (W - px) + '" y1="' + y + '" y2="' + y + '" stroke="rgba(255,255,255,0.05)" stroke-dasharray="4"/>' +
                   '<text x="' + (px - 4) + '" y="' + (y + 4) + '" text-anchor="end" font-size="9" fill="#64748b">' + v + '</text>';
        }).join('');

        // Week labels (bottom, max 6)
        var step = Math.max(1, Math.floor(n / 6));
        var xLabels = pts.filter(function (_, i) { return i % step === 0 || i === n - 1; }).map(function (p, idx) {
            var wi = idx * step;
            if (wi >= n) wi = n - 1;
            var d = new Date(weeks[wi] + 'T12:00:00');
            var label = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
            return '<text x="' + p[0] + '" y="' + (H + 2) + '" text-anchor="middle" font-size="9" fill="#64748b">' + label + '</text>';
        }).join('');

        return '<svg viewBox="0 0 ' + W + ' ' + (H + 12) + '" class="sparkline-svg" preserveAspectRatio="none">' +
            '<defs><linearGradient id="sg1" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#6366f1" stop-opacity="0.35"/>' +
                '<stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>' +
            '</linearGradient></defs>' +
            yLines +
            '<polygon points="' + area + '" fill="url(#sg1)"/>' +
            '<polyline points="' + line + '" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
            dots + xLabels +
        '</svg>';
    }

})();
