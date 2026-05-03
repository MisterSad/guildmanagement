/**
 * overview.js — Page Vue d'ensemble (Dashboard).
 *
 * Stats live dérivées des tables existantes :
 *   - Membres actifs   : count(guild_members)
 *   - Événements live  : count(event_status WHERE is_active=true)
 *   - Gloire totale    : sum(event_participants.score) Glory cette semaine
 *   - Sanctions        : count(sanctions)
 *
 * Recent activity : mix de event_status.updated_at, sanctions.created_at,
 * guild_members.created_at, top 6 par date desc.
 *
 * Quick actions : raccourcis vers les onglets/forms existants.
 */
(function () {

    if (!window.RAD) return;

    var db  = window.RAD.db;
    var t   = window.RAD.t;
    var esc = window.RAD.escapeHTML;
    var fmt = window.RAD.formatNumber;

    window.RAD_OVERVIEW = { load: loadOverview };

    async function loadOverview() {
        var panel = document.getElementById('gm-overview');
        if (!panel) return;

        // Skeleton
        renderShell(panel);

        if (!db) return;

        try {
            var week = window.RAD.getWeekStart();
            var [memCount, statusRows, gloryRows, sanctionsRows, recentMembers, recentSanctions] = await Promise.all([
                db.from('guild_members').select('id', { count: 'exact', head: true }),
                db.from('event_status').select('event_name, is_active, updated_at, session_id'),
                db.from('event_participants').select('score').eq('event_name', 'Glory').eq('week_start', week),
                db.from('sanctions').select('id, pseudo, comment, created_by, created_at').order('created_at', { ascending: false }).limit(5),
                db.from('guild_members').select('pseudo, created_at').order('created_at', { ascending: false }).limit(5),
                // (sanctions déjà récupérées ci-dessus, on réutilise)
                Promise.resolve(null)
            ]);

            var stats = {
                members:   memCount.count || 0,
                liveEvents: (statusRows.data || []).filter(function (s) { return s.is_active; }).length,
                liveEventNames: (statusRows.data || []).filter(function (s) { return s.is_active; }).map(function (s) { return prettyEventName(s.event_name); }),
                gloryTotal: (gloryRows.data || []).reduce(function (a, r) { return a + (r.score || 0); }, 0),
                sanctions: (sanctionsRows.data || []).length
            };

            // Activity feed : merge events + sanctions + new members
            var activity = [];
            (statusRows.data || []).forEach(function (s) {
                if (!s.updated_at) return;
                activity.push({
                    icon: s.is_active ? 'ph-play' : 'ph-stop-circle',
                    color: s.is_active ? 'success' : 'info',
                    text: prettyEventName(s.event_name) + ' ' + (s.is_active ? t('overview_event_started') : t('overview_event_ended')),
                    when: s.updated_at
                });
            });
            (sanctionsRows.data || []).forEach(function (s) {
                activity.push({
                    icon: 'ph-warning-octagon',
                    color: 'danger',
                    text: t('overview_sanction_for') + ' ' + s.pseudo + (s.created_by ? ' (' + s.created_by + ')' : ''),
                    when: s.created_at
                });
            });
            (recentMembers.data || []).forEach(function (m) {
                activity.push({
                    icon: 'ph-user-plus',
                    color: 'success',
                    text: m.pseudo + ' ' + t('overview_member_added'),
                    when: m.created_at
                });
            });
            activity.sort(function (a, b) {
                return new Date(b.when).getTime() - new Date(a.when).getTime();
            });
            activity = activity.slice(0, 6);

            renderPage(panel, stats, activity);
        } catch (err) {
            console.error('overview load', err);
        }
    }

    function prettyEventName(n) {
        if (!n) return '';
        if (n === 'ARMS RACE STAGE A') return 'Arms Race Stage A';
        if (n === 'ARMS RACE STAGE B') return 'Arms Race Stage B';
        if (n === 'Defend Trade Route') return 'DTR';
        return n;
    }

    function renderShell(panel) {
        panel.innerHTML =
            '<div class="gm-page">' +
                '<header class="gm-page-header">' +
                    '<div>' +
                        '<h1 class="gm-page-title">' + t('gm_overview_title') + '</h1>' +
                        '<p class="gm-page-subtitle">' + t('gm_overview_sub_real') + '</p>' +
                    '</div>' +
                '</header>' +
                '<div data-gm-overview-content></div>' +
            '</div>';
    }

    function renderPage(panel, stats, activity) {
        var content = panel.querySelector('[data-gm-overview-content]');
        if (!content) return;

        var liveEventsMeta = stats.liveEvents > 0
            ? stats.liveEventNames.join(' · ')
            : t('overview_no_live');

        var html =
            '<div class="gm-stat-grid">' +
                statTile(t('overview_s_members'), fmt(stats.members), null, 'ph-users', false, '') +
                statTile(t('overview_s_events'), String(stats.liveEvents), null, 'ph-sword', stats.liveEvents > 0, liveEventsMeta) +
                statTile(t('overview_s_glory'), formatBigNumber(stats.gloryTotal), 'up', 'ph-trophy', false, t('overview_s_glory_meta')) +
                statTile(t('overview_s_sanctions'), String(stats.sanctions), stats.sanctions > 0 ? 'down' : null, 'ph-warning-octagon', false, '') +
            '</div>' +
            '<div class="gm-section">' +
                '<div class="gm-section-head">' +
                    '<div class="gm-section-title"><i class="ph ph-pulse"></i> ' + t('overview_recent_activity') + '</div>' +
                '</div>' +
                renderActivityCard(activity) +
            '</div>' +
            '<div class="gm-section">' +
                '<div class="gm-section-head">' +
                    '<div class="gm-section-title"><i class="ph ph-sparkle"></i> ' + t('overview_quick_actions') + '</div>' +
                '</div>' +
                renderQuickActions() +
            '</div>';

        content.innerHTML = html;

        content.querySelectorAll('[data-gm-action]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var action = btn.getAttribute('data-gm-action');
                handleQuickAction(action);
            });
        });
    }

    function statTile(label, value, trend, icon, accent, meta) {
        return '<div class="gm-stat-tile">' +
            '<div class="gm-stat-tile-label">' +
                '<i class="ph ' + icon + '" style="color:' + (accent ? 'var(--accent)' : 'var(--fg-dim)') + ';"></i>' +
                esc(label) +
            '</div>' +
            '<div class="gm-stat-tile-value">' + esc(value) + '</div>' +
            (meta || trend
                ? '<div class="gm-stat-tile-meta' + (trend === 'up' ? ' gm-up' : trend === 'down' ? ' gm-down' : '') + '">' +
                    (trend === 'up' ? '<i class="ph ph-trend-up"></i>' : '') +
                    (trend === 'down' ? '<i class="ph ph-trend-down"></i>' : '') +
                    esc(meta || '') +
                  '</div>'
                : '') +
        '</div>';
    }

    function renderActivityCard(activity) {
        if (!activity.length) {
            return '<div class="gm-empty"><i class="ph-duotone ph-clock-counter-clockwise gm-icon"></i>' +
                '<div class="gm-empty-title">' + t('overview_no_activity') + '</div></div>';
        }
        var html = '<div class="gm-card gm-card-padded gm-col" style="gap:.75rem;">';
        activity.forEach(function (a, i) {
            var isLast = i === activity.length - 1;
            html +=
                '<div class="gm-row" style="gap:.75rem; padding:.4rem 0;' +
                    (!isLast ? ' border-bottom: 1px solid var(--border-soft); padding-bottom: .85rem;' : '') + '">' +
                    '<div style="width:36px; height:36px; border-radius:9px; background: var(--' + a.color + '-soft); color: var(--' + a.color + '); display:flex; align-items:center; justify-content:center; flex-shrink:0;">' +
                        '<i class="ph ' + a.icon + '"></i>' +
                    '</div>' +
                    '<div class="gm-grow">' +
                        '<div style="font-size:.9rem; font-weight:500;">' + esc(a.text) + '</div>' +
                        '<div class="gm-dim" style="font-size:.78rem;">' + relativeTime(a.when) + '</div>' +
                    '</div>' +
                '</div>';
        });
        html += '</div>';
        return html;
    }

    function renderQuickActions() {
        var actions = [
            { id: 'add-member',  icon: 'ph-user-plus',  label: t('overview_qa_add_member') },
            { id: 'start-svs',   icon: 'ph-sword',      label: t('overview_qa_start_svs') },
            { id: 'update-glory',icon: 'ph-trophy',     label: t('overview_qa_update_glory') },
            { id: 'create-acc',  icon: 'ph-key',        label: t('overview_qa_create_account') }
        ];
        return '<div class="gm-stat-grid">' +
            actions.map(function (a) {
                return '<button class="gm-card gm-card-padded gm-row" data-gm-action="' + a.id + '" style="cursor:pointer; gap:.75rem; background: var(--bg-1); text-align:left; color: var(--fg); font: inherit; border: 1px solid var(--border-soft); width:100%;">' +
                    '<div style="width:36px; height:36px; border-radius:9px; background: var(--accent-soft); color: var(--accent); display:flex; align-items:center; justify-content:center;">' +
                        '<i class="ph ' + a.icon + '"></i>' +
                    '</div>' +
                    '<div style="font-weight:500; font-size:.9rem;">' + esc(a.label) + '</div>' +
                    '<i class="ph ph-arrow-right" style="margin-left:auto; color: var(--fg-dim);"></i>' +
                '</button>';
            }).join('') +
        '</div>';
    }

    function handleQuickAction(action) {
        var clickAndFocus = function (tabId, focusId) {
            var tab = document.querySelector('.nav-tab[data-tab="' + tabId + '"]');
            if (tab) tab.click();
            if (focusId) {
                setTimeout(function () {
                    var inp = document.getElementById(focusId);
                    if (inp) { inp.focus(); inp.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
                }, 200);
            }
        };
        if (action === 'add-member')   clickAndFocus('admin-members', 'member-pseudo');
        if (action === 'start-svs')    clickAndFocus('event-svs');
        if (action === 'update-glory') clickAndFocus('event-glory');
        if (action === 'create-acc')   clickAndFocus('admin-home', 'account-id');
    }

    // ── Helpers ─────────────────────────────────────────────────────────────
    function formatBigNumber(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'k';
        return fmt(n);
    }

    function relativeTime(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        var diff = (Date.now() - d.getTime()) / 1000;
        if (diff < 60)        return t('overview_time_now');
        if (diff < 3600)      return Math.floor(diff / 60) + ' min';
        if (diff < 86400)     return Math.floor(diff / 3600) + ' h';
        if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' j';
        return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
    }

})();
