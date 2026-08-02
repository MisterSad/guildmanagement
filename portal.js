/**
 * portal.js — Player Portal dashboard (rendered once a player signs in).
 * Desktop grid layout, collapses to a single column on mobile.
 * Sections: profile header, stat tiles, per-event progression charts
 * (native canvas, no external chart library), active event score
 * submission, power update and guild transfer.
 */
(function () {

    var t = function (k) { return (window.GM_I18N && window.GM_I18N.t) ? window.GM_I18N.t(k) : k; };
    var esc = window.GM ? window.GM.escapeHTML : function (s) { return s; };

    var portalState = {
        player: null,       // { pseudo, guild, overall_power }
        sessions: [],       // active event sessions
        history: null,      // per-event history from get-history
        activeTab: 'dashboard',
        chartsDrawn: false
    };

    // ─── Invoke the member-portal edge function with the current session ────
    function invoke(action, payload) {
        var supabase = window.GM ? window.GM.db : null;
        if (!supabase) return Promise.resolve({ ok: false, error: 'no_client' });
        return supabase.functions.invoke('member-portal', {
            body: { action: action, payload: payload || {} }
        }).then(function (r) {
            var data = r && r.data;
            if (!data) return { ok: false, error: (r && r.error && r.error.message) || 'request_failed' };
            return data;
        }).catch(function () {
            return { ok: false, error: 'request_failed' };
        });
    }

    // ─── Load everything for the dashboard ─────────────────────────────────
    async function loadDashboard() {
        var root = document.getElementById('portal-dashboard-root');
        if (!root) return;
        root.innerHTML = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading your portal...</div></div>';

        var [profile, history] = await Promise.all([
            invoke('get-active-sessions', {}),
            invoke('get-history', {})
        ]);

        if (!profile.ok) {
            root.innerHTML = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-warning-circle gm-icon"></i><div class="gm-empty-title">Unable to load your portal.</div><div class="gm-empty-sub">' + esc(profile.error || 'unknown error') + '</div></div>';
            return;
        }

        portalState.player = {
            pseudo: profile.pseudo,
            guild: profile.guild,
            overall_power: profile.overall_power
        };
        portalState.sessions = profile.sessions || [];
        portalState.history = history.ok ? (history.events || {}) : null;
        portalState.chartsDrawn = false;

        renderDashboard();
    }

    // ─── Render the full dashboard ─────────────────────────────────────────
    function renderDashboard() {
        var root = document.getElementById('portal-dashboard-root');
        if (!root) return;
        var p = portalState.player;
        var initials = window.GM.avatarInit(p.pseudo);

        var html =
            '<div class="portal-dashboard">' +

                // Profile header
                '<div class="portal-header">' +
                    '<div class="gm-avatar gm-avatar-lg gm-avatar-accent">' + esc(initials) + '</div>' +
                    '<div class="portal-header-info">' +
                        '<div class="portal-header-name">' + esc(p.pseudo) + '</div>' +
                        '<div class="portal-header-guild"><i class="ph ph-flag-banner"></i> ' + esc(p.guild) + '</div>' +
                    '</div>' +
                    '<div class="portal-header-power">' +
                        '<div class="portal-header-power-label">Combat Power</div>' +
                        '<div class="portal-header-power-value">' + esc(window.GM.formatPower(p.overall_power)) + '</div>' +
                    '</div>' +
                '</div>' +

                // Tabs
                '<div class="portal-tabs">' +
                    '<button type="button" class="portal-tab portal-tab-dashboard active" data-portal-tab="dashboard"><i class="ph ph-chart-line-up"></i><span>My Progress</span></button>' +
                    '<button type="button" class="portal-tab portal-tab-events" data-portal-tab="events"><i class="ph ph-calendar-dots"></i><span>Active Events</span></button>' +
                    '<button type="button" class="portal-tab portal-tab-settings" data-portal-tab="settings"><i class="ph ph-sliders-horizontal"></i><span>Account</span></button>' +
                '</div>' +

                // Tab panels
                '<div id="portal-panel-dashboard" class="portal-panel"></div>' +
                '<div id="portal-panel-events" class="portal-panel hidden"></div>' +
                '<div id="portal-panel-settings" class="portal-panel hidden"></div>' +
            '</div>';

        root.innerHTML = html;

        root.querySelectorAll('.portal-tab').forEach(function (btn) {
            btn.addEventListener('click', function () {
                portalState.activeTab = btn.getAttribute('data-portal-tab');
                root.querySelectorAll('.portal-tab').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                ['dashboard', 'events', 'settings'].forEach(function (name) {
                    var panel = document.getElementById('portal-panel-' + name);
                    if (panel) panel.classList.toggle('hidden', name !== portalState.activeTab);
                });
                if (portalState.activeTab === 'dashboard' && !portalState.chartsDrawn) {
                    renderDashboardPanel();
                }
            });
        });

        renderDashboardPanel();
        renderEventsPanel();
        renderSettingsPanel();
    }

    // ─── Panel 1: My Progress (stat tiles + charts) ────────────────────────
    function renderDashboardPanel() {
        var panel = document.getElementById('portal-panel-dashboard');
        if (!panel) return;

        var hist = portalState.history || {};
        var keys = Object.keys(hist);
        var totalCount = 0, totalAttended = 0;
        keys.forEach(function (k) {
            totalCount += hist[k].count;
            totalAttended += hist[k].attended;
        });
        var overallRate = totalCount > 0 ? Math.round((totalAttended / totalCount) * 100) : 0;

        var tilesHtml =
            '<div class="portal-stats">' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(totalCount) + '</div><div class="portal-stat-label">Events tracked</div></div>' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(totalAttended) + '</div><div class="portal-stat-label">Participated</div></div>' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(overallRate) + '%</div><div class="portal-stat-label">Attendance rate</div></div>' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(window.GM.formatPower(portalState.player.overall_power)) + '</div><div class="portal-stat-label">Current power</div></div>' +
            '</div>';

        var chartsHtml = '';
        if (keys.length === 0) {
            chartsHtml = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph-duotone ph-chart-bar gm-icon"></i><div class="gm-empty-title">No history yet.</div><div class="gm-empty-sub">Your progression charts will appear here after your first events.</div></div>';
        } else {
            keys.forEach(function (key, idx) {
                var ev = hist[key];
                chartsHtml += renderChartCard(key, ev, idx);
            });
        }

        panel.innerHTML = tilesHtml + '<div class="portal-charts-grid">' + chartsHtml + '</div>';
        portalState.chartsDrawn = true;

        // Draw charts after insertion
        window.requestAnimationFrame(function () {
            keys.forEach(function (key, idx) {
                drawChart(key, hist[key], idx);
            });
        });
    }

    // ─── Chart card (canvas bar chart per event type) ──────────────────────
    function renderChartCard(eventKey, ev, idx) {
        var icon = window.GM.getEventIcon(eventKey);
        var theme = window.GM.getEventTheme(eventKey);
        var attended = ev.attended || 0;

        var historyHtml = '';
        (ev.history || []).slice(0, 8).forEach(function (h) {
            var label = h.week_start || h.session_id || '?';
            var badge = h.participated || h.sub_present
                ? '<span class="gm-chip gm-chip-success" style="font-size:0.6rem;">P</span>'
                : (h.excused ? '<span class="gm-chip gm-chip-warning" style="font-size:0.6rem;">E</span>'
                   : '<span class="gm-chip" style="font-size:0.6rem;">A</span>');
            historyHtml +=
                '<div class="portal-chart-row">' +
                    '<span class="portal-chart-row-label">' + esc(String(label).slice(0, 10)) + '</span>' +
                    badge +
                    '<span class="portal-chart-row-score">' + esc(window.GM.formatNumber(h.score || 0)) + '</span>' +
                '</div>';
        });

        return '<div class="portal-chart-card ' + theme + '">' +
                    '<div class="portal-chart-head">' +
                        '<div class="portal-chart-title"><i class="ph ' + icon + '"></i> ' + esc(eventKey) + '</div>' +
                        '<div class="portal-chart-meta">' + esc(attended) + '/' + esc(ev.count) + ' (' + esc(ev.rate) + '%)</div>' +
                    '</div>' +
                    '<canvas class="portal-chart-canvas" data-chart-key="' + esc(eventKey) + '" data-chart-idx="' + idx + '" width="600" height="160"></canvas>' +
                    '<div class="portal-chart-list">' + historyHtml + '</div>' +
                '</div>';
    }

    // ─── Native canvas bar chart: participated vs total, last 8 sessions ───
    function drawChart(eventKey, ev, idx) {
        var canvas = document.querySelector('.portal-chart-canvas[data-chart-idx="' + idx + '"]');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        var list = (ev.history || []).slice(0, 8).reverse();
        if (list.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.font = '12px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No data', w / 2, h / 2);
            return;
        }

        var padL = 6, padR = 6, padT = 14, padB = 22;
        var chartW = w - padL - padR;
        var chartH = h - padT - padB;
        var barW = Math.min(34, (chartW / list.length) * 0.6);
        var gap = list.length > 1 ? (chartW - barW * list.length) / (list.length - 1) : 0;

        var colors = { ok: 'rgba(52,211,153,0.85)', miss: 'rgba(248,113,113,0.7)', excused: 'rgba(251,191,36,0.8)' };
        var maxScore = 0;
        list.forEach(function (h) { if ((h.score || 0) > maxScore) maxScore = h.score; });
        if (maxScore <= 0) maxScore = 1;

        list.forEach(function (h, i) {
            var x = padL + i * (barW + gap);
            var barH = Math.max(3, (chartH - 4) * ((h.score || 0) / maxScore));
            var y = padT + chartH - barH;

            var color = (h.participated || h.sub_present) ? colors.ok : (h.excused ? colors.excused : colors.miss);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(x, y, barW, barH, 3) : ctx.rect(x, y, barW, barH);
            ctx.fill();

            // Date label
            var label = (h.week_start || h.session_id || '').toString().slice(5, 10);
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.font = '9px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(label, x + barW / 2, padT + chartH + 12);
        });

        // Score markers (max / mid)
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(window.GM.formatNumber(maxScore), padL, padT + 8);
    }

    // ─── Panel 2: Active Events (score submission) ─────────────────────────
    function renderEventsPanel() {
        var panel = document.getElementById('portal-panel-events');
        if (!panel) return;

        if (!portalState.sessions || portalState.sessions.length === 0) {
            panel.innerHTML = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph-duotone ph-calendar-blank gm-icon"></i><div class="gm-empty-title">No active events right now.</div><div class="gm-empty-sub">When your guild starts an event, you will be able to submit your scores here.</div></div>';
            return;
        }

        var html = '';
        portalState.sessions.forEach(function (sess) {
            html += renderEventCard(sess);
        });
        panel.innerHTML = html;
        wireEventCards(panel);
    }

    function renderEventCard(sess) {
        var eventName = sess.event_name;
        var isSvsOrGvg = eventName === 'SvS' || eventName === 'GvG';
        var isDtr = eventName === 'Defend Trade Route';
        var isShadowfront = eventName === 'Shadowfront';
        var icon = window.GM.getEventIcon(eventName);
        var theme = window.GM.getEventTheme(eventName);

        var EVENTS_WITHOUT_SCORE = ['Defend Trade Route', 'Shadowfront', 'ARMS RACE STAGE A', 'ARMS RACE STAGE B'];
        var hasScore = EVENTS_WITHOUT_SCORE.indexOf(eventName) === -1;

        var curr = sess.current_data || {};
        var isChecked = curr.participated > 0;
        var isLateChecked = !!curr.late;
        var isExcusedChecked = !!curr.excused;
        var isAppointedChecked = !!curr.appointed;

        var fieldsHtml = '';

        fieldsHtml +=
            '<div class="portal-field">' +
                '<label class="portal-toggle-label"><div class="check-toggle"><input type="checkbox" class="participation-checkbox portal-check-participated" ' + (isChecked ? 'checked' : '') + '><span class="check-slider"></span></div><span>I participated in this event</span></label>' +
            '</div>';

        if (isDtr) {
            fieldsHtml +=
                '<div class="portal-field">' +
                    '<label class="portal-toggle-label"><div class="check-toggle"><input type="checkbox" class="participation-checkbox portal-check-appointed" ' + (isAppointedChecked ? 'checked' : '') + '><span class="check-slider"></span></div><span>Appointed</span></label>' +
                '</div>';
        }

        if (isShadowfront) {
            fieldsHtml +=
                '<div class="portal-field">' +
                    '<label class="portal-toggle-label"><div class="check-toggle"><input type="checkbox" class="participation-checkbox portal-check-late" ' + (isLateChecked ? 'checked' : '') + '><span class="check-slider"></span></div><span>Late</span></label>' +
                '</div>' +
                '<div class="portal-field">' +
                    '<label class="portal-toggle-label"><div class="check-toggle"><input type="checkbox" class="participation-checkbox portal-check-excused" ' + (isExcusedChecked ? 'checked' : '') + '><span class="check-slider"></span></div><span>Excused</span></label>' +
                '</div>';
        }

        if (hasScore) {
            if (isSvsOrGvg) {
                fieldsHtml +=
                    '<div class="portal-field"><label class="portal-field-label">Day 1 to 5 score</label><input type="text" class="gm-input gm-input-sm portal-score-prep" value="' + esc(curr.score_prep != null ? curr.score_prep : '') + '" placeholder="e.g. 150000"></div>' +
                    '<div class="portal-field"><label class="portal-field-label">Day 6 score</label><input type="text" class="gm-input gm-input-sm portal-score-pvp" value="' + esc(curr.score_pvp != null ? curr.score_pvp : '') + '" placeholder="e.g. 50000"></div>';
            } else {
                fieldsHtml +=
                    '<div class="portal-field"><label class="portal-field-label">Score</label><input type="text" class="gm-input gm-input-sm portal-score" value="' + esc(curr.score != null ? curr.score : '') + '" placeholder="e.g. 45000"></div>';
            }
        }

        var statusBadge = curr.is_pending
            ? '<span class="gm-chip" style="margin-left:auto; background:rgba(245,158,11,0.12); color:var(--warning); border:1px solid rgba(245,158,11,0.25);">Pending approval</span>'
            : '';

        var startLabel = sess.start_at ? window.GM.formatDateTimeUTC(sess.start_at) : '';

        return '<div class="portal-event-card ' + theme + '" data-event="' + esc(eventName) + '" data-session="' + esc(sess.session_id) + '">' +
                    '<div class="portal-event-head">' +
                        '<div class="portal-event-title"><i class="ph ' + icon + '"></i> ' + esc(eventName) + '</div>' +
                        statusBadge +
                    '</div>' +
                    (startLabel ? '<div class="portal-event-sub"><i class="ph ph-clock"></i> ' + esc(startLabel) + '</div>' : '') +
                    '<div class="portal-event-fields">' + fieldsHtml + '</div>' +
                    '<button type="button" class="gm-btn gm-btn-primary gm-btn-sm portal-submit-event-btn"><i class="ph ph-paper-plane-right"></i><span>Submit Scores</span></button>' +
                '</div>';
    }

    function wireEventCards(panel) {
        panel.querySelectorAll('.portal-score, .portal-score-prep, .portal-score-pvp').forEach(function (inp) {
            window.GM.attachNumberFormatter(inp);
        });

        panel.querySelectorAll('.portal-check-appointed').forEach(function (cb) {
            cb.addEventListener('change', function () {
                if (cb.checked) {
                    var card = cb.closest('.portal-event-card');
                    var partCb = card ? card.querySelector('.portal-check-participated') : null;
                    if (partCb) partCb.checked = true;
                }
            });
        });

        panel.querySelectorAll('.portal-submit-event-btn').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                var card = btn.closest('.portal-event-card');
                var eventName = card.getAttribute('data-event');
                var sessionId = card.getAttribute('data-session');

                var participated = card.querySelector('.portal-check-participated')?.checked;
                var appointed = card.querySelector('.portal-check-appointed')?.checked;
                var late = card.querySelector('.portal-check-late')?.checked;
                var excused = card.querySelector('.portal-check-excused')?.checked;

                var scoreVal = card.querySelector('.portal-score')?.value;
                var scorePrepVal = card.querySelector('.portal-score-prep')?.value;
                var scorePvpVal = card.querySelector('.portal-score-pvp')?.value;

                var payload = {
                    event_name: eventName,
                    session_id: sessionId,
                    participated: participated,
                    appointed: appointed,
                    late: late,
                    excused: excused,
                    score: scoreVal !== undefined ? window.GM.parseNumber(scoreVal) : undefined,
                    score_prep: scorePrepVal !== undefined ? window.GM.parseNumber(scorePrepVal) : undefined,
                    score_pvp: scorePvpVal !== undefined ? window.GM.parseNumber(scorePvpVal) : undefined
                };

                btn.disabled = true;
                var span = btn.querySelector('span');
                var origText = span ? span.textContent : '';
                if (span) span.textContent = 'Submitting...';

                try {
                    var res = await invoke('submit-scores', payload);
                    if (!res.ok) throw new Error(res.error || 'submit_failed');
                    window.GM.showToast('Scores submitted! Pending officer approval.', 'success');
                    var badge = card.querySelector('.gm-chip');
                    if (!badge) {
                        card.querySelector('.portal-event-head').insertAdjacentHTML('beforeend', '<span class="gm-chip" style="margin-left:auto; background:rgba(245,158,11,0.12); color:var(--warning); border:1px solid rgba(245,158,11,0.25);">Pending approval</span>');
                    }
                } catch (err) {
                    console.error(err);
                    window.GM.showToast('Submission failed. Check your parameters.', 'error');
                } finally {
                    btn.disabled = false;
                    if (span) span.textContent = origText;
                }
            });
        });
    }

    // ─── Panel 3: Account (power + transfer) ───────────────────────────────
    function renderSettingsPanel() {
        var panel = document.getElementById('portal-panel-settings');
        if (!panel) return;

        panel.innerHTML =
            '<div class="portal-settings-grid">' +

                '<div class="portal-card">' +
                    '<div class="portal-card-title"><i class="ph ph-sword"></i> Update My Power</div>' +
                    '<div class="portal-row">' +
                        '<input type="text" id="portal-user-power" class="gm-input" placeholder="e.g. 80000000" value="' + esc(portalState.player.overall_power || '') + '">' +
                        '<button type="button" id="portal-update-power-btn" class="gm-btn gm-btn-primary gm-btn-sm"><i class="ph ph-floppy-disk"></i><span>Save</span></button>' +
                    '</div>' +
                '</div>' +

                '<div class="portal-card">' +
                    '<div class="portal-card-title"><i class="ph ph-swap"></i> Request Guild Transfer</div>' +
                    '<div class="portal-row">' +
                        '<select id="portal-transfer-select" class="gm-input"><option value="">Select Target Guild...</option></select>' +
                        '<button type="button" id="portal-transfer-btn" class="gm-btn gm-btn-primary gm-btn-sm" disabled><i class="ph ph-paper-plane-tilt"></i><span>Send</span></button>' +
                    '</div>' +
                    '<div id="portal-transfer-msg" class="portal-msg"></div>' +
                '</div>' +

                '<div class="portal-card">' +
                    '<div class="portal-card-title"><i class="ph ph-sign-out"></i> Session</div>' +
                    '<button type="button" class="gm-btn gm-btn-ghost portal-exit-btn"><i class="ph ph-arrow-left"></i><span>Switch Account / Exit</span></button>' +
                '</div>' +

            '</div>';

        var exitBtn = document.querySelector('.portal-exit-btn');
        if (exitBtn) {
            exitBtn.addEventListener('click', function () {
                window.GM.logout().then(function () {
                    var portalView = document.getElementById('player-portal-view');
                    var loginView = document.getElementById('login-view');
                    if (portalView) portalView.classList.add('hidden');
                    if (portalView) portalView.classList.remove('portal-connected');
                    if (loginView) loginView.classList.remove('hidden');
                }).catch(function () {
                    var portalView = document.getElementById('player-portal-view');
                    var loginView = document.getElementById('login-view');
                    if (portalView) portalView.classList.add('hidden');
                    if (portalView) portalView.classList.remove('portal-connected');
                    if (loginView) loginView.classList.remove('hidden');
                });
            });
        }

        // Power update
        var powerInput = document.getElementById('portal-user-power');
        var powerBtn = document.getElementById('portal-update-power-btn');
        if (powerInput) window.GM.attachNumberFormatter(powerInput);

        if (powerBtn) powerBtn.addEventListener('click', async function () {
            var powerVal = powerInput ? parseInt(String(powerInput.value).replace(/[^0-9]/g, ''), 10) : 0;
            if (isNaN(powerVal) || powerVal < 0) {
                window.GM.showToast('Please enter a valid power number.', 'error');
                return;
            }
            powerBtn.disabled = true;
            var span = powerBtn.querySelector('span');
            var origText = span ? span.textContent : '';
            if (span) span.textContent = 'Saving...';
            try {
                var res = await invoke('update-power', { power: powerVal });
                if (!res.ok) throw new Error(res.error || 'update_failed');
                portalState.player.overall_power = powerVal;
                var headerPower = document.querySelector('.portal-header-power-value');
                if (headerPower) headerPower.textContent = window.GM.formatPower(powerVal);
                window.GM.showToast('Your combat power has been updated!', 'success');
            } catch (err) {
                window.GM.showToast('Failed to update combat power: ' + err.message, 'error');
            } finally {
                powerBtn.disabled = false;
                if (span) span.textContent = origText;
            }
        });

        // Transfer
        var transferSelect = document.getElementById('portal-transfer-select');
        var transferBtn = document.getElementById('portal-transfer-btn');
        var transferMsg = document.getElementById('portal-transfer-msg');

        function setTransferMsg(msg, type) {
            if (!transferMsg) return;
            transferMsg.textContent = msg;
            transferMsg.style.color = type === 'error' ? 'var(--danger)' : 'var(--success)';
            transferMsg.style.display = 'block';
        }

        invoke('get-transfer-guilds', {}).then(function (res) {
            if (!res.ok) {
                transferSelect.innerHTML = '<option value="">Unable to load guilds</option>';
                return;
            }
            if (!res.guilds || res.guilds.length === 0) {
                transferSelect.innerHTML = '<option value="">No other guilds on this server</option>';
                return;
            }
            var opts = '<option value="">Select Target Guild...</option>';
            res.guilds.forEach(function (g) {
                var displayName = g.name ? g.name : g.id;
                opts += '<option value="' + esc(g.id) + '">' + esc(displayName) + '</option>';
            });
            transferSelect.innerHTML = opts;
        });

        if (transferSelect && transferBtn) {
            transferSelect.addEventListener('change', function () {
                transferBtn.disabled = !this.value;
            });
            transferBtn.addEventListener('click', async function () {
                var targetGuild = transferSelect.value;
                if (!targetGuild) return;
                transferBtn.disabled = true;
                transferSelect.disabled = true;
                var span = transferBtn.querySelector('span');
                var origText = span ? span.textContent : '';
                if (span) span.textContent = 'Sending...';
                transferMsg.style.display = 'none';
                try {
                    var res = await invoke('submit-transfer-request', { targetGuild: targetGuild });
                    if (!res.ok) {
                        var code = res.error || 'unknown';
                        if (code === 'already_pending') setTransferMsg('You already have a pending transfer request.', 'error');
                        else if (code === 'same_guild') setTransferMsg('You cannot transfer to your current guild.', 'error');
                        else setTransferMsg('Transfer request failed (' + code + ').', 'error');
                    } else {
                        setTransferMsg('Transfer request sent! Waiting for approval.', 'success');
                    }
                } catch (err) {
                    setTransferMsg('An error occurred.', 'error');
                } finally {
                    if (span) span.textContent = origText;
                    transferBtn.disabled = !transferSelect.value;
                    transferSelect.disabled = false;
                }
            });
        }
    }

    // ─── Public API ────────────────────────────────────────────────────────
    window.GM_PORTAL = {
        loadDashboard: loadDashboard,
        renderDashboard: renderDashboard
    };

})();
