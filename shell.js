/**
 * shell.js — Pilote du shell v2 (sidebar + topbar + bottom-nav + drawer).
 *
 * Stratégie : on ne touche pas au routing existant. On rend la nav et,
 * au clic, on déclenche un click sur la `.nav-tab[data-tab="..."]` legacy
 * correspondante. C'est `app.js` qui fait le tab switching réel.
 *
 * On observe aussi le DOM pour réagir si quelqu'un change l'onglet
 * autrement (ex: app.js qui clique sur svsTab au login R4).
 */
(function () {

    if (!window.GM) return;

    var t = window.GM.t;
    var esc = window.GM.escapeHTML;

    // ── Définition des items de nav ─────────────────────────────────────────
    // tabId = data-tab existant que app.js sait gérer.
    // Mapping panel-actif → item courant : on utilise `panels` pour savoir si
    // une .nav-tab.active appartient à cet item.
    var NAV_ITEMS = [
        { id: 'overview',  tabId: 'gm-overview', m3Icon: 'dashboard', icon: 'ph-squares-four',    labelKey: 'gm_nav_overview',  section: 'play',  panels: ['gm-overview'] },
        { id: 'members',   tabId: 'admin-members', m3Icon: 'group', icon: 'ph-users',         labelKey: 'gm_nav_members',   section: 'play',  panels: ['admin-members'] },
        { id: 'events',    tabId: 'event-svs',   m3Icon: 'swords', icon: 'ph-sword',           labelKey: 'gm_nav_events',    section: 'play',
          panels: ['event-svs', 'event-gvg', 'event-shadowfront', 'event-dtr', 'event-arms-race'] },
        { id: 'glory',     tabId: 'event-glory', m3Icon: 'trophy', icon: 'ph-trophy',          labelKey: 'gm_nav_glory',     section: 'play',  panels: ['event-glory'] },
        { id: 'history',   tabId: 'event-history', m3Icon: 'history', icon: 'ph-clock-counter-clockwise', labelKey: 'gm_nav_history', section: 'play',  panels: ['event-history'] },
        { id: 'stats',     tabId: 'stats-admin', m3Icon: 'leaderboard', icon: 'ph-chart-bar',       labelKey: 'gm_nav_stats',     section: 'play',  panels: ['stats-admin'] },

        // Leader Hall lives in `play`, not `admin`: it's a real-time, daily-use
        // chat surface (like Events/History), not an occasional configuration
        // screen — grouping it with Accounts/Banned/Sanctions buried it among
        // items with a completely different usage pattern (UX audit, 2026-08-31).
        { id: 'leader-hall', tabId: 'tab-leader-hall', m3Icon: 'forum', icon: 'ph-chat-circle-dots', labelKey: 'nav_leader_hall', section: 'play', panels: ['tab-leader-hall'] },

        { id: 'accounts',  tabId: 'admin-home',  m3Icon: 'manage_accounts', icon: 'ph-key',             labelKey: 'gm_nav_accounts',  section: 'admin', panels: ['admin-home'] },
        { id: 'discord',   tabId: 'admin-discord', m3Icon: 'notifications', icon: 'ph-bell-ringing',   labelKey: 'gm_nav_discord',   section: 'admin', panels: ['admin-discord'] },
        { id: 'sanctions', tabId: 'tab-sanctions', m3Icon: 'gavel', icon: 'ph-warning-octagon', labelKey: 'gm_nav_sanctions', section: 'admin', panels: ['tab-sanctions'] },
        { id: 'banned',    tabId: 'admin-banned', m3Icon: 'block', icon: 'ph-prohibit',        labelKey: 'gm_nav_banned',    section: 'admin', panels: ['admin-banned'] },
        // section:'footer' (not 'admin'): a donation link isn't an admin
        // configuration screen either — rendered as a lighter-weight link
        // next to the sidebar's legal footer instead of the main nav list.
        { id: 'subscription', tabId: 'tab-subscription', m3Icon: 'local_cafe', icon: 'ph-coffee', labelKey: 'gm_nav_donate', section: 'footer', adminOnly: true, panels: ['tab-subscription'] },

        { id: 'superadmin-accounts', tabId: 'admin-superadmin', m3Icon: 'admin_panel_settings', icon: 'ph-shield-check', labelKey: 'gm_nav_superadmin_accounts', section: 'superadmin', r5Only: true, panels: ['admin-superadmin'] },
        { id: 'settings', tabId: 'tab-settings', m3Icon: 'tune', icon: 'ph-note-pencil', labelKey: 'gm_nav_settings', section: 'superadmin', r5Only: true, panels: ['tab-settings'] },
        { id: 'tickets', tabId: 'tab-tickets', m3Icon: 'confirmation_number', icon: 'ph-ticket', labelKey: 'gm_nav_tickets', section: 'superadmin', r5Only: true, panels: ['tab-tickets'] }
    ];

    function visibleNavItems() {
        var role = getUserRole();
        var items = [];
        var paymentsDisabled = window.GM.isPaymentsDisabled();
        NAV_ITEMS.forEach(function (i) {
            if (i.r5Only && role !== 'super_admin') return;
            if (i.adminOnly && role !== 'super_admin' && role !== 'guild_admin') return;
            if (i.id === 'subscription' && paymentsDisabled) return;
            items.push(Object.assign({}, i));
        });
        return items;
    }

    var BREAKPOINT_MOBILE = 900;

    // ── State interne ───────────────────────────────────────────────────────
    var state = {
        active: 'accounts',  // sidebar item actif
        mobile: window.matchMedia('(max-width: ' + BREAKPOINT_MOBILE + 'px)').matches,
        drawerOpen: false
    };

    // ── Bootstrap : on s'initialise quand le dashboard devient visible ──────
    document.addEventListener('DOMContentLoaded', function () {
        wrapDashboardInShell();
        renderShell();
        renderEventsTabs();
        observeActiveTab();
        observeViewport();
        wireLoginPasswordToggle();
        wireSearchClearButtons();
    });

    // ── Events tabs-pill : injectée dans chaque event panel ─────────────────
    var EVENT_TABS = [
        { id: 'event-svs',          m3Icon: 'rocket_launch', icon: 'ph-swords',       label: 'SvS', colorVar: 'var(--gm-event-svs)' },
        { id: 'event-gvg',          m3Icon: 'swords',        icon: 'ph-flag-banner',  label: 'GvG', colorVar: 'var(--gm-event-gvg)' },
        { id: 'event-shadowfront',  m3Icon: 'radar',         icon: 'ph-ghost',        label: 'Shadowfront', colorVar: 'var(--gm-event-shadowfront)' },
        { id: 'event-dtr',          m3Icon: 'local_shipping',icon: 'ph-truck',        label: 'DTR', colorVar: 'var(--gm-event-dtr)' },
        { id: 'event-arms-race',    m3Icon: 'bolt',          icon: 'ph-crosshair',    label: 'Arms Race', colorVar: 'var(--gm-event-armsrace)' }
    ];

    function renderEventsTabs() {
        document.querySelectorAll('[data-gm-events-tabs]').forEach(function (slot) {
            var ownerPanel = slot.closest('.tab-panel');
            var ownerId = ownerPanel ? ownerPanel.id : '';
            var html = '<div class="gm-tabs-pill" style="margin-bottom:1rem; flex-wrap:nowrap; overflow-x:auto;">';
            EVENT_TABS.forEach(function (e) {
                var active = e.id === ownerId;
                var m3Icon = e.m3Icon || 'swords';
                var iconStyle = active ? ('style="color:' + e.colorVar + '; font-size:1.15rem; margin-right:0.35rem; vertical-align:middle;"') : 'style="font-size:1.15rem; margin-right:0.35rem; vertical-align:middle;"';
                html += '<button class="gm-tab-pill' + (active ? ' gm-active' : '') + '" data-gm-event-tab="' + e.id + '">' +
                    '<span class="material-symbols-rounded gm-icon" ' + iconStyle + '>' + m3Icon + '</span> ' + e.label +
                '</button>';
            });
            html += '</div>';
            slot.innerHTML = html;
            slot.querySelectorAll('[data-gm-event-tab]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var tabId = btn.getAttribute('data-gm-event-tab');
                    localStorage.setItem('gm_active_event_tab', tabId);

                    var dashboard = document.getElementById('dashboard-view');
                    if (dashboard) {
                        dashboard.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
                        var panel = document.getElementById(tabId);
                        if (panel) panel.classList.add('active');
                    }

                    renderEventsTabs();

                    if (tabId === 'event-arms-race' && window.GM_ARMSRACE && window.GM_ARMSRACE.load) {
                        window.GM_ARMSRACE.load();
                    } else if (tabId === 'event-shadowfront' && window.GM_SHADOWFRONT && window.GM_SHADOWFRONT.load) {
                        window.GM_SHADOWFRONT.load();
                    }

                    if (window.GM_APP && window.GM_APP.onTabActivated) {
                        window.GM_APP.onTabActivated(tabId);
                    }
                });
            });
        });
    }

    // ── Login : password visibility toggle (Material Symbols & Phosphor) ───
    function wireLoginPasswordToggle() {
        document.querySelectorAll('[data-gm-pwd-toggle]').forEach(function (btn) {
            var wrap = btn.closest('.gm-input-with-icon');
            var input = wrap ? wrap.querySelector('input[type="password"], input[type="text"]') : null;
            if (!input) return;
            btn.addEventListener('click', function () {
                var isPwd = input.type === 'password';
                input.type = isPwd ? 'text' : 'password';
                var icon = btn.querySelector('i');
                if (icon) icon.className = isPwd ? 'ph ph-eye-slash' : 'ph ph-eye';
                var matIcon = btn.querySelector('.material-symbols-rounded');
                if (matIcon) matIcon.textContent = isPwd ? 'visibility_off' : 'visibility';
            });
        });
    }

    // ── Search inputs : quick clear button handler (delegated) ────────────
    function wireSearchClearButtons() {
        // Dynamic visibility handler for search clear buttons
        document.addEventListener('input', function (e) {
            var input = e.target;
            if (!input || input.tagName !== 'INPUT') return;
            var wrap = input.closest('.gm-input-with-icon, .input-wrapper, .search-wrapper, .ocr-filter-bar') || input.parentElement;
            if (!wrap) return;
            var clearBtn = wrap.querySelector('[data-gm-search-clear], .gm-search-clear-btn');
            if (!clearBtn) return;
            if (input.value && input.value.trim().length > 0) {
                clearBtn.classList.add('gm-visible');
            } else {
                clearBtn.classList.remove('gm-visible');
            }
        });

        // Clear and trigger re-render on button click
        document.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-gm-search-clear], .gm-search-clear-btn');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            var wrap = btn.closest('.gm-input-with-icon, .input-wrapper, .search-wrapper, .ocr-filter-bar') || btn.parentElement;
            var input = wrap ? wrap.querySelector('input') : null;
            if (!input) return;
            input.value = '';
            btn.classList.remove('gm-visible');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.focus();
        });
    }

    // ── Wrap des panels existants dans la structure shell ───────────────────
    function wrapDashboardInShell() {
        var dashboard = document.getElementById('dashboard-view');
        if (!dashboard || dashboard.querySelector('.gm-shell')) return;

        // Récupérer tous les panels de tab existants
        var panels = Array.prototype.slice.call(dashboard.querySelectorAll(':scope > .dashboard-content.tab-panel'));

        // Construire le shell
        var shell = document.createElement('div');
        shell.className = 'gm-shell';
        shell.innerHTML =
            '<aside class="gm-sidebar" data-gm-sidebar></aside>' +
            '<div class="gm-main">' +
                '<header class="gm-topbar" data-gm-topbar></header>' +
                '<div id="guild-warning-banner" class="gm-warning-banner" style="display: none;"></div>' +
                '<div class="gm-content" data-gm-content></div>' +
            '</div>' +
            '<nav class="gm-bottom-nav" data-gm-bottom-nav></nav>' +
            '<div class="gm-drawer-backdrop" data-gm-drawer-backdrop></div>' +
            '<div class="gm-drawer" data-gm-drawer></div>';

        dashboard.appendChild(shell);

        // Déplacer les panels dans .gm-content
        var content = shell.querySelector('[data-gm-content]');
        panels.forEach(function (p) { content.appendChild(p); });

        // Crée un panel placeholder pour Overview (sera rempli au step 5)
        if (!document.getElementById('gm-overview')) {
            var ov = document.createElement('main');
            ov.className = 'dashboard-content tab-panel';
            ov.id = 'gm-overview';
            ov.innerHTML =
                '<div class="gm-page">' +
                  '<header class="gm-page-header">' +
                    '<div>' +
                      '<h1 class="gm-page-title">' + t('gm_overview_title') + '</h1>' +
                      '<p class="gm-page-subtitle">' + t('gm_overview_sub') + '</p>' +
                    '</div>' +
                  '</header>' +
                  '<div class="gm-empty">' +
                    '<i class="ph-duotone ph-rocket-launch gm-icon"></i>' +
                    '<div class="gm-empty-title">' + t('gm_overview_soon') + '</div>' +
                    '<div class="gm-empty-hint">' + t('gm_overview_soon_hint') + '</div>' +
                  '</div>' +
                '</div>';
            content.appendChild(ov);
        }

        // On crée un bouton .nav-tab caché pour gm-overview ET on attache son
        // handler ici (app.js a déjà attaché ses handlers à load — il ne nous
        // verra pas si on l'ajoute après).
        var legacyNav = dashboard.querySelector('.app-header .nav-tabs');
        if (legacyNav && !legacyNav.querySelector('[data-tab="gm-overview"]')) {
            var btn = document.createElement('button');
            btn.className = 'nav-tab';
            btn.setAttribute('data-tab', 'gm-overview');
            btn.setAttribute('data-view', 'dashboard-view');
            btn.style.display = 'none';
            legacyNav.insertBefore(btn, legacyNav.firstChild);

            btn.addEventListener('click', function () {
                // Remove .active from all sibling nav-tabs and tab-panels
                dashboard.querySelectorAll('.nav-tab').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                dashboard.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
                var panel = document.getElementById('gm-overview');
                if (panel) panel.classList.add('active');
                if (window.GM_OVERVIEW) window.GM_OVERVIEW.load();
            });
        }
    }

    // ── Render complet du shell ─────────────────────────────────────────────
    function renderShell() {
        renderSidebar();
        renderTopbar();
        renderBottomNav();
        renderDrawer();
        wireLangSwitcher();
        wireSettingsSubtabs();
    }

    // ── Settings sub-tabs (Draft / SvS / GvG consolidated into one tab) ──────
    var settingsSubtabsWired = false;
    function wireSettingsSubtabs() {
        if (settingsSubtabsWired) return;
        var bar = document.getElementById('settings-subtabs');
        if (!bar) return;
        settingsSubtabsWired = true;

        var PANEL_TO_LOADER = {
            draft: function () { if (window.GM_SETTINGS) window.GM_SETTINGS.load(); },
            svs:   function () { if (window.GM_SVS_MATCHUP) window.GM_SVS_MATCHUP.load(); },
            gvg:   function () { if (window.GM_GVG_MATCHUP) window.GM_GVG_MATCHUP.load(); }
        };

        bar.querySelectorAll('.gm-settings-tab').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var key = btn.getAttribute('data-settings-tab');
                bar.querySelectorAll('.gm-settings-tab').forEach(function (b) {
                    var active = b.getAttribute('data-settings-tab') === key;
                    b.classList.toggle('active', active);
                    b.style.background = active ? 'var(--accent)' : 'transparent';
                    b.style.color = active ? '#fff' : 'var(--text-muted)';
                });
                document.querySelectorAll('#tab-settings [data-settings-panel]').forEach(function (panel) {
                    panel.classList.toggle('hidden', panel.getAttribute('data-settings-panel') !== key);
                });
                var loader = PANEL_TO_LOADER[key];
                if (loader) loader();
            });
        });
    }

    function getUserName() {
        return localStorage.getItem('gm_user') || 'Membre';
    }
    function getUserRole() {
        return window.GM.roleFromStorage() || 'member';
    }
    function getUserRoleLong() {
        var r = getUserRole();
        if (r === 'super_admin') return 'Super Admin';
        if (window.currentGuildRestriction) {
            return 'Admin ' + window.currentGuildRestriction;
        }
        return 'Admin';
    }

    function checkSubscriptionStatus() {
        // Platform is free since v127.0: read-only restrictions and subscription banners are neutralized.
        document.body.classList.remove('guild-read-only');
        var banner = document.getElementById('guild-warning-banner');
        if (banner) {
            banner.style.display = 'none';
            banner.innerHTML = '';
        }
        return false;
    }

    function renderGuildSelectorHtml() {
        var isSuperAdmin = window.GM.isSuperAdmin();
        var guilds = window.guildsList || [];
        if (window.currentGuildRestriction) {
            guilds = [window.currentGuildRestriction];
            window.currentGuild = window.currentGuildRestriction;
            localStorage.setItem('gm_current_guild', window.currentGuildRestriction);
        }

        if (isSuperAdmin && !window.currentGuildRestriction) {
            var guildOptions = guilds.map(function(g) {
                var sVal = (window.guildsData && window.guildsData[g] && window.guildsData[g].server_number) ? String(window.guildsData[g].server_number).replace(/^#+/, '') : '';
                var sNum = sVal ? ' (#' + esc(sVal) + ')' : '';
                return '<option value="' + esc(g) + '"' + (window.currentGuild === g ? ' selected' : '') + '>' + esc(g) + sNum + '</option>';
            }).join('');
            return '<div class="gm-sidebar-guild-select-wrapper">' +
                '<select class="gm-sidebar-guild-select" data-gm-guild-select>' +
                    guildOptions +
                '</select>' +
            '</div>';
        } else {
            var displayGuild = window.currentGuildRestriction || window.currentGuild || 'ALPHA';
            var sVal = (window.guildsData && window.guildsData[displayGuild] && window.guildsData[displayGuild].server_number) ? String(window.guildsData[displayGuild].server_number).replace(/^#+/, '') : '';
            var sNum = sVal ? ' #' + esc(sVal) : '';
            return '<div class="gm-sidebar-guild-badge">' + esc(displayGuild) + sNum + '</div>';
        }
    }

    function getSubscriptionCardHtml() {
        var activeGuild = window.currentGuild || 'ALPHA';
        var cardTitle = esc(activeGuild) + ' Guild';
        var cardDesc = 'Standard Plan';
        var pillLabel = 'Active Plan';
        var pillClass = '';
        var icon = 'ph-crown';

        if (window.guildsData && window.guildsData[activeGuild]) {
            var sub = window.guildsData[activeGuild];
            if (sub.type === 'Unlimited') {
                cardTitle = esc(activeGuild) + ' • Unlimited';
                cardDesc = 'Unlimited access for all guild members.';
                pillLabel = 'Unlimited';
                pillClass = 'gm-sub-unlimited';
                icon = 'ph-infinity';
            } else if (sub.type === 'Lifetime') {
                cardTitle = esc(activeGuild) + ' • Lifetime';
                cardDesc = 'Lifetime access - never expires.';
                pillLabel = 'Lifetime';
                pillClass = 'gm-sub-unlimited';
                icon = 'ph-infinity';
            } else if (sub.type === 'Premium') {
                if (sub.end) {
                    var endMs = new Date(sub.end).getTime();
                    var diff = endMs - Date.now();
                    if (diff <= 0) {
                        cardTitle = esc(activeGuild) + ' • Premium';
                        cardDesc = 'Subscription expired. Read-only mode active.';
                        pillLabel = 'Expired';
                        pillClass = 'gm-sub-expired';
                        icon = 'ph-lock-keyhole';
                    } else {
                        var days = Math.floor(diff / (1000 * 60 * 60 * 24));
                        var hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                        cardTitle = esc(activeGuild) + ' • Premium';
                        cardDesc = 'Active plan • Expires in ' + days + 'd ' + hours + 'h';
                        pillLabel = 'Premium Tier';
                        icon = 'ph-sparkle';
                    }
                } else {
                    cardTitle = esc(activeGuild) + ' • Premium';
                    cardDesc = 'Subscription expired.';
                    pillLabel = 'Expired';
                    pillClass = 'gm-sub-expired';
                    icon = 'ph-lock-keyhole';
                }
            }
        }

        return '<div class="gm-sidebar-sub-card">' +
            renderGuildSelectorHtml() +
            '<div class="gm-sub-card-pill ' + pillClass + '">' +
                '<i class="ph-fill ' + icon + '"></i> ' + pillLabel +
            '</div>' +
        '</div>';
    }

    function renderSidebar() {
        var el = document.querySelector('[data-gm-sidebar]');
        if (!el) return;

        checkSubscriptionStatus();

        var canReportBug = window.GM.isGuildAdmin ? window.GM.isGuildAdmin() : false;

        var visible = visibleNavItems();
        var playItems = visible.filter(function (i) { return i.section === 'play'; });
        var adminItems = visible.filter(function (i) { return i.section === 'admin'; });
        var superAdminItems = visible.filter(function (i) { return i.section === 'superadmin'; });
        var footerItems = visible.filter(function (i) { return i.section === 'footer'; });

        var userAvatarInitials = esc(window.GM.avatarInit(getUserName()));

        var navHtml = '';
        if (playItems.length > 0) {
            navHtml += '<div class="gm-nav-section-label">' + t('gm_nav_play') + '</div>' +
                playItems.map(navItemHtml).join('');
        }
        if (adminItems.length > 0) {
            navHtml += '<div class="gm-nav-section-label">' + t('gm_nav_admin') + '</div>' +
                adminItems.map(navItemHtml).join('');
        }
        if (superAdminItems.length > 0) {
            navHtml += '<div class="gm-nav-section-label">' + t('gm_nav_superadmin') + '</div>' +
                superAdminItems.map(navItemHtml).join('');
        }

        var html =
            '<div class="gm-sidebar-header">' +
                '<div class="gm-sidebar-user-row">' +
                    '<div class="gm-user-avatar-ring">' +
                        '<div class="gm-user-avatar">' + userAvatarInitials + '</div>' +
                    '</div>' +
                    '<div class="gm-sidebar-user-info">' +
                        '<div class="gm-sidebar-user-name">' + esc(getUserName()) + '</div>' +
                        '<div class="gm-sidebar-user-role">' + getUserRoleLong() + '</div>' +
                    '</div>' +
                    '<button class="gm-sidebar-logout" data-gm-logout title="' + t('nav_logout_title') + '">' +
                        '<span class="material-symbols-rounded">logout</span>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<nav class="gm-sidebar-nav">' +
                navHtml +
            '</nav>' +
            getSubscriptionCardHtml() +
            footerItems.map(function (item) {
                return '<button type="button" class="gm-btn gm-btn-ghost gm-btn-sm gm-sidebar-report-bug" data-gm-nav-item="' + item.id + '">' +
                    '<span class="material-symbols-rounded" style="font-size:1.1rem;">' + (item.m3Icon || 'circle') + '</span>' +
                    '<span>' + t(item.labelKey) + '</span>' +
                '</button>';
            }).join('') +
            (canReportBug
                ? '<button type="button" class="gm-btn gm-btn-ghost gm-btn-sm gm-sidebar-report-bug" data-gm-report-bug>' +
                    '<span class="material-symbols-rounded" style="font-size:1.1rem;">bug_report</span>' +
                    '<span>' + t('ticket_report_bug') + '</span>' +
                  '</button>'
                : '') +
            '<div class="gm-sidebar-legal-footer">' +
                '<div class="gm-app-version">' + esc(window.GM && window.GM.appVersion ? window.GM.appVersion : '') + '</div>' +
                '<a href="terms.html" class="gm-sidebar-legal-link" data-i18n="footer_terms">Terms &amp; Conditions</a>' +
            '</div>';

        el.innerHTML = html;

        el.querySelectorAll('[data-gm-nav-item]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                gotoItem(btn.getAttribute('data-gm-nav-item'));
            });
        });

        var rb = el.querySelector('[data-gm-report-bug]');
        if (rb) rb.addEventListener('click', openBugReportModal);

        var gSel = el.querySelector('[data-gm-guild-select]');
        if (gSel) {
            gSel.addEventListener('change', function () {
                var newGuild = gSel.value;
                localStorage.setItem('gm_current_guild', newGuild);
                window.currentGuild = newGuild;
                renderSidebar();
                renderTopbar();
                if (window.GM_APP && window.GM_APP.reloadActiveView) {
                    window.GM_APP.reloadActiveView();
                } else {
                    window.location.reload();
                }
            });
        }

        var lo = el.querySelector('[data-gm-logout]');
        if (lo) {
            lo.addEventListener('click', function () {
                var legacy = document.getElementById('logout-btn');
                if (legacy) legacy.click();
            });
        }
    }

    function navItemHtml(item) {
        var isActive = state.active === item.id;
        var label = t(item.labelKey);
        var m3Icon = item.m3Icon || 'circle';

        return '<button class="gm-nav-item' + (isActive ? ' gm-active' : '') + '" data-gm-nav-item="' + item.id + '">' +
                '<span class="material-symbols-rounded gm-icon">' + m3Icon + '</span>' +
                '<span>' + label + '</span>' +
            '</button>';
    }

    function renderTopbar() {
        var el = document.querySelector('[data-gm-topbar]');
        if (!el) return;

        checkSubscriptionStatus();

        var brandHtml = state.mobile
            ? '<div class="gm-topbar-mobile-brand">' +
                '<div class="gm-brand-mark">FGF</div>' +
              '</div>'
            : '<div class="gm-topbar-brand"></div>';

        var isSuperAdmin = window.GM.isSuperAdmin();
        var isServerAdmin = window.GM.isServerAdmin ? window.GM.isServerAdmin() : false;
        var serverRestriction = localStorage.getItem('gm_server_restriction');

        var guilds = window.guildsList || [];
        if (window.currentGuildRestriction) {
            guilds = [window.currentGuildRestriction];
            window.currentGuild = window.currentGuildRestriction;
            localStorage.setItem('gm_current_guild', window.currentGuildRestriction);
        } else if (isServerAdmin && serverRestriction && window.guildsData) {
            guilds = guilds.filter(function(g) {
                return window.guildsData[g] && String(window.guildsData[g].server_number) === String(serverRestriction);
            });
            if (guilds.length > 0 && guilds.indexOf(window.currentGuild) === -1) {
                window.currentGuild = guilds[0];
                localStorage.setItem('gm_current_guild', guilds[0]);
            }
        }
        var guildOptions = guilds.map(function(g) {
            return '<option value="' + esc(g) + '"' + (window.currentGuild === g ? ' selected' : '') + '>' + esc(g) + '</option>';
        }).join('');

        var selectStyle = (isSuperAdmin || (isServerAdmin && guilds.length > 1))
            ? 'padding: 0.35rem 0.8rem; font-size: 0.85rem; font-weight: 600; border-radius: 6px; background: var(--bg-soft); border: 1px solid var(--border-soft); color: var(--text-main); cursor: pointer; outline: none; transition: border-color 0.2s;'
            : 'display: none; padding: 0.35rem 0.8rem; font-size: 0.85rem; font-weight: 600; border-radius: 6px; background: var(--bg-soft); border: 1px solid var(--border-soft); color: var(--text-main); cursor: pointer; outline: none; transition: border-color 0.2s;';

        var canReportBug = window.GM.isGuildAdmin ? window.GM.isGuildAdmin() : false;

        var html = brandHtml +
            '<div class="gm-topbar-actions">' +
                '<select id="guild-selector" class="gm-select" style="' + selectStyle + '">' +
                    guildOptions +
                '</select>' +
                (canReportBug
                    ? '<button class="gm-btn gm-btn-ghost gm-btn-sm" data-gm-report-bug title="' + t('ticket_report_bug') + '" style="gap:0.3rem;">' +
                        '<span class="material-symbols-rounded" style="font-size:1.05rem;">bug_report</span>' +
                        '<span class="gm-report-bug-label" style="font-size:0.78rem; font-weight:600;">' + t('ticket_report_bug') + '</span>' +
                      '</button>'
                    : '') +
                '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm" data-gm-logout title="' + t('nav_logout_title') + '">' +
                    '<span class="material-symbols-rounded">logout</span>' +
                '</button>' +
            '</div>';
        el.innerHTML = html;

        var gs = el.querySelector('#guild-selector');
        if (gs) {
            gs.addEventListener('change', function () {
                var newGuild = gs.value;
                localStorage.setItem('gm_current_guild', newGuild);
                window.currentGuild = newGuild;
                
                // Re-render topbar & sidebar immediately to update subscription status and card!
                renderSidebar();
                renderTopbar();
                
                if (window.GM_APP && window.GM_APP.reloadActiveView) {
                    window.GM_APP.reloadActiveView();
                } else {
                    window.location.reload();
                }
            });
        }

        var lo = el.querySelector('[data-gm-logout]');
        if (lo) lo.addEventListener('click', function () {
            var legacy = document.getElementById('logout-btn');
            if (legacy) legacy.click();
        });

        var rb = el.querySelector('[data-gm-report-bug]');
        if (rb) rb.addEventListener('click', openBugReportModal);
    }

    // ── Bug-report ticket modal ──────────────────────────────────────────────
    function openBugReportModal() {
        if (!window.GM || !window.GM.isGuildAdmin()) return;
        if (document.getElementById('bug-report-modal')) return;

        var esc = window.GM.escapeHTML || function (s) { return s; };
        var t_ = function (k) { return window.GM.t ? window.GM.t(k) : k; };
        var env = (window.GM && window.GM.detectClientEnvironment)
            ? window.GM.detectClientEnvironment()
            : { appVersion: (window.GM && window.GM.appVersion) || 'V3.5.3', os: 'Unknown OS', browser: 'Unknown Browser' };

        var overlay = document.createElement('div');
        overlay.className = 'gm-modal-overlay visible';
        overlay.id = 'bug-report-modal';
        overlay.innerHTML =
            '<div class="gm-modal-card" style="max-width:580px; width:94%; max-height:90vh; overflow-y:auto; text-align:left;">' +
                '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.9rem; position:sticky; top:0; background:var(--bg-card); z-index:2; padding-bottom:0.4rem; border-bottom:1px solid var(--border-soft);">' +
                    '<div style="display:flex; align-items:center; gap:0.55rem;">' +
                        '<span class="material-symbols-rounded" style="color:var(--accent); font-size:1.3rem;">bug_report</span>' +
                        '<strong style="font-size:1.1rem;">' + t_('ticket_report_bug') + '</strong>' +
                    '</div>' +
                    '<button type="button" class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm bug-report-close" title="Close"><span class="material-symbols-rounded">close</span></button>' +
                '</div>' +
                '<div class="gm-modal-body" style="display:flex; flex-direction:column; gap:0.85rem;">' +
                    '<div class="gm-form-group">' +
                        '<label class="gm-label" for="ticket-title">' + t_('ticket_title') + ' *</label>' +
                        '<input type="text" id="ticket-title" class="gm-input" maxlength="120" placeholder="' + t_('ticket_title_ph') + '">' +
                    '</div>' +
                    '<div style="display:flex; gap:0.8rem; flex-wrap:wrap;">' +
                        '<div class="gm-form-group" style="flex:1; min-width:140px;">' +
                            '<label class="gm-label" for="ticket-category">' + t_('ticket_category') + '</label>' +
                            '<select id="ticket-category" class="gm-select">' +
                                '<option value="bug">' + t_('ticket_cat_bug') + '</option>' +
                                '<option value="feature">' + t_('ticket_cat_feature') + '</option>' +
                                '<option value="other">' + t_('ticket_cat_other') + '</option>' +
                            '</select>' +
                        '</div>' +
                        '<div class="gm-form-group" style="flex:1; min-width:140px;">' +
                            '<label class="gm-label" for="ticket-severity">' + t_('ticket_severity') + '</label>' +
                            '<select id="ticket-severity" class="gm-select">' +
                                '<option value="low">' + t_('ticket_sev_low') + '</option>' +
                                '<option value="medium" selected>' + t_('ticket_sev_medium') + '</option>' +
                                '<option value="high">' + t_('ticket_sev_high') + '</option>' +
                                '<option value="critical">' + t_('ticket_sev_critical') + '</option>' +
                            '</select>' +
                        '</div>' +
                    '</div>' +
                    '<div class="gm-form-group">' +
                        '<label class="gm-label" for="ticket-current-behavior">' + t_('ticket_current_behavior') + ' *</label>' +
                        '<textarea id="ticket-current-behavior" class="gm-input" rows="3" maxlength="2000" placeholder="' + t_('ticket_current_behavior_ph') + '" style="resize:vertical; min-height:75px;"></textarea>' +
                    '</div>' +
                    '<div class="gm-form-group">' +
                        '<label class="gm-label" for="ticket-expected-behavior">' + t_('ticket_expected_behavior') + ' *</label>' +
                        '<textarea id="ticket-expected-behavior" class="gm-input" rows="3" maxlength="2000" placeholder="' + t_('ticket_expected_behavior_ph') + '" style="resize:vertical; min-height:75px;"></textarea>' +
                    '</div>' +
                    '<div class="gm-form-group">' +
                        '<label class="gm-label" for="ticket-steps">' + t_('ticket_steps') + '</label>' +
                        '<textarea id="ticket-steps" class="gm-input" rows="3" maxlength="2000" placeholder="' + t_('ticket_steps_ph') + '" style="resize:vertical; min-height:70px;"></textarea>' +
                    '</div>' +
                    '<div class="gm-form-group">' +
                        '<label class="gm-label" for="ticket-additional-context">' + t_('ticket_additional_context') + '</label>' +
                        '<textarea id="ticket-additional-context" class="gm-input" rows="2" maxlength="2000" placeholder="' + t_('ticket_additional_context_ph') + '" style="resize:vertical; min-height:60px;"></textarea>' +
                    '</div>' +
                    '<div class="gm-form-group">' +
                        '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.25rem;">' +
                            '<label class="gm-label" style="margin:0;">' + esc(t_('ticket_screenshots_title')) + '</label>' +
                            '<span style="font-size:0.72rem; color:var(--text-muted);"><span id="ticket-screenshots-count">0</span>/3</span>' +
                        '</div>' +
                        '<div id="ticket-dropzone" style="border:1px dashed var(--border-soft); border-radius:var(--radius-sm); padding:0.75rem; text-align:center; cursor:pointer; background:rgba(255,255,255,0.02); transition:border-color 0.2s, background 0.2s;">' +
                            '<input type="file" id="ticket-file-input" accept="image/png,image/jpeg,image/webp" multiple style="display:none;">' +
                            '<div style="display:flex; align-items:center; justify-content:center; gap:0.4rem; color:var(--text-muted); font-size:0.78rem;">' +
                                '<span class="material-symbols-rounded" style="font-size:1.15rem; color:var(--accent);">add_photo_alternate</span>' +
                                '<span>' + esc(t_('ticket_screenshots_hint')) + '</span>' +
                            '</div>' +
                        '</div>' +
                        '<div id="ticket-screenshots-preview" style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-top:0.5rem;"></div>' +
                    '</div>' +
                    '<div style="background:rgba(255,255,255,0.03); border:1px solid var(--border-soft); border-radius:var(--radius-sm); padding:0.55rem 0.75rem; font-size:0.78rem;">' +
                        '<div style="font-weight:700; color:var(--text-muted); text-transform:uppercase; font-size:0.68rem; letter-spacing:0.05em; margin-bottom:0.35rem; display:flex; align-items:center; gap:0.3rem;">' +
                            '<span class="material-symbols-rounded" style="font-size:0.95rem;">devices</span> ' + esc(t_('ticket_env_title')) +
                        '</div>' +
                        '<div style="display:flex; flex-wrap:wrap; gap:0.4rem;">' +
                            '<span class="gm-chip" style="font-size:0.72rem; padding:2px 8px; border-radius:6px; background:var(--bg-soft); border:1px solid var(--border-soft);">FGF: <strong style="color:var(--fg);">' + esc(env.appVersion) + '</strong></span>' +
                            '<span class="gm-chip" style="font-size:0.72rem; padding:2px 8px; border-radius:6px; background:var(--bg-soft); border:1px solid var(--border-soft);">OS: <strong style="color:var(--fg);">' + esc(env.os) + '</strong></span>' +
                            '<span class="gm-chip" style="font-size:0.72rem; padding:2px 8px; border-radius:6px; background:var(--bg-soft); border:1px solid var(--border-soft);">Browser: <strong style="color:var(--fg);">' + esc(env.browser) + '</strong></span>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div id="bug-report-msg" class="gm-dim" style="min-height:1rem; margin-top:0.6rem; font-size:0.8rem;"></div>' +
                '<div style="display:flex; justify-content:flex-end; gap:0.6rem; margin-top:1rem; position:sticky; bottom:0; background:var(--bg-card); z-index:2; padding-top:0.4rem; border-top:1px solid var(--border-soft);">' +
                    '<button type="button" class="gm-btn gm-btn-ghost bug-report-close">' + t_('cancel') + '</button>' +
                    '<button type="button" class="gm-btn gm-btn-primary" id="bug-report-submit">' + t_('ticket_submit') + '</button>' +
                '</div>' +
            '</div>';

        document.body.appendChild(overlay);

        var attachedScreenshots = [];

        function renderScreenshots() {
            var countEl = overlay.querySelector('#ticket-screenshots-count');
            if (countEl) countEl.textContent = String(attachedScreenshots.length);
            var previewEl = overlay.querySelector('#ticket-screenshots-preview');
            if (!previewEl) return;
            previewEl.innerHTML = '';
            attachedScreenshots.forEach(function (dataUrl, idx) {
                var item = document.createElement('div');
                item.style.cssText = 'position:relative; width:80px; height:60px; border-radius:6px; overflow:hidden; border:1px solid var(--border-soft); background:#000; display:inline-block;';
                item.innerHTML =
                    '<img src="' + dataUrl + '" style="width:100%; height:100%; object-fit:cover;">' +
                    '<button type="button" class="gm-btn gm-btn-ghost gm-btn-icon" data-remove="' + idx + '" style="position:absolute; top:2px; right:2px; width:20px; height:20px; min-width:20px; background:rgba(0,0,0,0.7); border-radius:999px; color:#fff; padding:0; line-height:1; font-size:12px;" title="Remove">×</button>';
                item.querySelector('[data-remove]').addEventListener('click', function (e) {
                    e.stopPropagation();
                    attachedScreenshots.splice(idx, 1);
                    renderScreenshots();
                });
                previewEl.appendChild(item);
            });
        }

        async function handleFiles(files) {
            if (!files || files.length === 0) return;
            for (var i = 0; i < files.length; i++) {
                var f = files[i];
                if (!f.type || !f.type.startsWith('image/')) continue;
                if (attachedScreenshots.length >= 3) {
                    if (window.GM && window.GM.showToast) window.GM.showToast(t_('ticket_screenshots_max_err'), 'error');
                    break;
                }
                try {
                    var dataUrl = (window.GM && window.GM.compressImageForUpload)
                        ? await window.GM.compressImageForUpload(f, 1280, 0.82)
                        : await new Promise(function(res){ var r = new FileReader(); r.onload = function(){ res(r.result); }; r.readAsDataURL(f); });
                    attachedScreenshots.push(dataUrl);
                    renderScreenshots();
                } catch (err) {
                    console.warn('Screenshot upload error', err);
                }
            }
        }

        var dropzone = overlay.querySelector('#ticket-dropzone');
        var fileInput = overlay.querySelector('#ticket-file-input');
        if (dropzone && fileInput) {
            dropzone.addEventListener('click', function () { fileInput.click(); });
            fileInput.addEventListener('change', function () {
                handleFiles(fileInput.files);
                fileInput.value = '';
            });
            dropzone.addEventListener('dragover', function (e) {
                e.preventDefault();
                dropzone.style.borderColor = 'var(--accent)';
                dropzone.style.background = 'rgba(255,255,255,0.06)';
            });
            dropzone.addEventListener('dragleave', function () {
                dropzone.style.borderColor = 'var(--border-soft)';
                dropzone.style.background = 'rgba(255,255,255,0.02)';
            });
            dropzone.addEventListener('drop', function (e) {
                e.preventDefault();
                dropzone.style.borderColor = 'var(--border-soft)';
                dropzone.style.background = 'rgba(255,255,255,0.02)';
                if (e.dataTransfer && e.dataTransfer.files) {
                    handleFiles(e.dataTransfer.files);
                }
            });
        }

        function onPaste(e) {
            if (!e.clipboardData || !e.clipboardData.items) return;
            var items = e.clipboardData.items;
            var imageFiles = [];
            for (var i = 0; i < items.length; i++) {
                if (items[i].type && items[i].type.startsWith('image/')) {
                    var blob = items[i].getAsFile();
                    if (blob) imageFiles.push(blob);
                }
            }
            if (imageFiles.length > 0) {
                e.preventDefault();
                handleFiles(imageFiles);
            }
        }
        window.addEventListener('paste', onPaste);

        function close() {
            window.removeEventListener('paste', onPaste);
            if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
        overlay.querySelectorAll('.bug-report-close').forEach(function (b) { b.addEventListener('click', close); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

        var submit = overlay.querySelector('#bug-report-submit');
        submit.addEventListener('click', async function () {
            var title = (overlay.querySelector('#ticket-title').value || '').trim();
            var category = overlay.querySelector('#ticket-category').value;
            var severity = overlay.querySelector('#ticket-severity').value;
            var currentBehavior = (overlay.querySelector('#ticket-current-behavior').value || '').trim();
            var expectedBehavior = (overlay.querySelector('#ticket-expected-behavior').value || '').trim();
            var steps = (overlay.querySelector('#ticket-steps').value || '').trim();
            var additionalContext = (overlay.querySelector('#ticket-additional-context').value || '').trim();
            var msgEl = overlay.querySelector('#bug-report-msg');

            if (!title || !currentBehavior || !expectedBehavior) {
                msgEl.textContent = t_('ticket_missing_fields');
                msgEl.style.color = '#ef4444';
                return;
            }

            var description = (window.GM && window.GM.formatTicketDescription)
                ? window.GM.formatTicketDescription({
                    currentBehavior: currentBehavior,
                    expectedBehavior: expectedBehavior,
                    steps: steps,
                    additionalContext: additionalContext,
                    env: env
                })
                : (currentBehavior + '\n\n' + expectedBehavior);

            submit.disabled = true;
            submit.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem;">sync</span> ' + t_('ticket_submitting');
            msgEl.textContent = '';
            try {
                var db = (window.GM && window.GM.db) ? window.GM.db : null;
                if (!db || !db.functions) throw new Error('db unavailable');
                var res = await db.functions.invoke('tickets', {
                    body: {
                        action: 'create',
                        title: title,
                        description: description,
                        category: category,
                        severity: severity,
                        current_behavior: currentBehavior,
                        expected_behavior: expectedBehavior,
                        steps: steps,
                        additional_context: additionalContext,
                        env: env,
                        attachments: attachedScreenshots
                    }
                });
                var data = res && res.data;
                if (!data || !data.ok) {
                    throw new Error((data && data.error) || 'request_failed');
                }
                var num = String(data.ticket_number).padStart(4, '0');
                msgEl.textContent = t_('ticket_success') + ' #TICKET-' + num;
                msgEl.style.color = '#34d399';
                if (window.GM.showToast) window.GM.showToast(t_('ticket_success') + ' #TICKET-' + num, 'success');
                setTimeout(close, 1800);
            } catch (err) {
                console.error('ticket submit error', err);
                msgEl.textContent = (err && err.message) || 'Error';
                msgEl.style.color = '#ef4444';
                submit.disabled = false;
                submit.innerHTML = t_('ticket_submit');
            }
        });
    }

    function renderBottomNav() {
        var el = document.querySelector('[data-gm-bottom-nav]');
        if (!el) return;
        // 5 items principaux + More
        var primary = ['overview', 'members', 'events', 'history', 'stats'];
        var html = '<div class="gm-bottom-nav-inner">';
        primary.forEach(function (id) {
            var item = NAV_ITEMS.find(function (i) { return i.id === id; });
            if (!item) return;
            var isActive = state.active === id;
            var m3Icon = item.m3Icon || 'circle';
            html += '<button class="gm-bottom-nav-item' + (isActive ? ' gm-active' : '') + '" data-gm-nav-item="' + id + '">' +
                        '<span class="material-symbols-rounded gm-icon">' + m3Icon + '</span>' +
                        '<span>' + t(item.labelKey) + '</span>' +
                    '</button>';
        });
        html += '<button class="gm-bottom-nav-item" data-gm-more>' +
                    '<span class="material-symbols-rounded gm-icon">more_horiz</span>' +
                    '<span class="gm-bottom-nav-unread-badge hidden" id="bottom-nav-more-badge">0</span>' +
                    '<span>' + t('gm_nav_more') + '</span>' +
                '</button>';
        html += '</div>';
        el.innerHTML = html;

        el.querySelectorAll('[data-gm-nav-item]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                gotoItem(btn.getAttribute('data-gm-nav-item'));
            });
        });
        var moreBtn = el.querySelector('[data-gm-more]');
        if (moreBtn) moreBtn.addEventListener('click', openDrawer);

        if (typeof window !== 'undefined' && window.GM_LEADER_HALL && typeof window.GM_LEADER_HALL.updateAllUnreadBadges === 'function') {
            window.GM_LEADER_HALL.updateAllUnreadBadges();
        }
    }

    function renderDrawer() {
        var drawer = document.querySelector('[data-gm-drawer]');
        var backdrop = document.querySelector('[data-gm-drawer-backdrop]');
        if (!drawer || !backdrop) return;

        var html = '<div class="gm-drawer-handle"></div><div class="gm-drawer-grid">';
        visibleNavItems().forEach(function (item) {
            var isActive = state.active === item.id;
            var label = t(item.labelKey);
            var m3Icon = item.m3Icon || 'circle';
            var badgeHtml = (item.id === 'leader-hall') ? '<span class="gm-drawer-unread-badge hidden" id="drawer-badge-leader-hall">0</span>' : '';

            html += '<button class="gm-drawer-item' + (isActive ? ' gm-active' : '') + '" data-gm-nav-item="' + item.id + '">' +
                        badgeHtml +
                        '<span class="material-symbols-rounded gm-icon">' + m3Icon + '</span>' +
                        '<span>' + label + '</span>' +
                    '</button>';
        });
        html += '<div class="gm-sidebar-legal-footer" style="grid-column: 1 / -1; margin-top: 0.5rem; border-top: 1px solid var(--border-soft); padding: 0.75rem 0.5rem 0.25rem 0.5rem;">' +
                    '<div class="gm-app-version">' + esc(window.GM && window.GM.appVersion ? window.GM.appVersion : '') + '</div>' +
                    '<a href="terms.html" class="gm-sidebar-legal-link" data-i18n="footer_terms">Terms &amp; Conditions</a>' +
                '</div>';
        html += '</div>';
        drawer.innerHTML = html;

        drawer.querySelectorAll('[data-gm-nav-item]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                gotoItem(btn.getAttribute('data-gm-nav-item'));
                closeDrawer();
            });
        });
        backdrop.addEventListener('click', closeDrawer);

        if (typeof window !== 'undefined' && window.GM_LEADER_HALL && typeof window.GM_LEADER_HALL.updateAllUnreadBadges === 'function') {
            window.GM_LEADER_HALL.updateAllUnreadBadges();
        }
    }

    function openDrawer() {
        state.drawerOpen = true;
        document.querySelector('[data-gm-drawer]').classList.add('gm-open');
        document.querySelector('[data-gm-drawer-backdrop]').classList.add('gm-open');
    }
    function closeDrawer() {
        state.drawerOpen = false;
        document.querySelector('[data-gm-drawer]').classList.remove('gm-open');
        document.querySelector('[data-gm-drawer-backdrop]').classList.remove('gm-open');
    }

    function wireLangSwitcher() {
        // Re-render quand i18n change
    }

    // ── Navigation : déléguée à app.js via les anciennes .nav-tab ───────────
    function gotoItem(itemId) {
        var item = NAV_ITEMS.find(function (i) { return i.id === itemId; });
        if (!item) return;
        localStorage.setItem('gm_active_tab', itemId);

        var targetTabId = item.tabId;
        if (itemId === 'events') {
            var savedEventTab = localStorage.getItem('gm_active_event_tab');
            if (savedEventTab && item.panels.indexOf(savedEventTab) !== -1) {
                targetTabId = savedEventTab;
            }
        }

        var dashboard = document.getElementById('dashboard-view');
        if (dashboard) {
            dashboard.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
            var panel = document.getElementById(targetTabId);
            if (panel) {
                panel.classList.add('active');
            }
        }

        if (window.GM_APP && window.GM_APP.onTabActivated) {
            window.GM_APP.onTabActivated(targetTabId);
        }
    }

    // ── Observer le panel actif courant pour syncer l'item actif ────────────
    function observeActiveTab() {
        var dashboard = document.getElementById('dashboard-view');
        if (!dashboard) return;

        function detect() {
            // Quel panel est actif ?
            var activePanel = dashboard.querySelector('.tab-panel.active');
            if (!activePanel) return;
            var pid = activePanel.id;
            var item = NAV_ITEMS.find(function (i) { return i.panels.indexOf(pid) !== -1; });
            if (!item) return;
            localStorage.setItem('gm_active_tab', item.id);
            if (item.panels.length > 1) {
                localStorage.setItem('gm_active_event_tab', pid);
            }
            if (item.id === state.active) return;
            state.active = item.id;
            renderSidebar();
            renderTopbar();
            renderBottomNav();
            renderDrawer();
        }

        // Détection initiale
        detect();
        // Observer les changements de classe sur les .tab-panel
        var obs = new MutationObserver(detect);
        obs.observe(dashboard, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    function observeViewport() {
        var mq = window.matchMedia('(max-width: ' + BREAKPOINT_MOBILE + 'px)');
        mq.addEventListener('change', function (e) {
            state.mobile = e.matches;
            renderSidebar();
            renderTopbar();
            if (!e.matches) closeDrawer();
        });
    }

    // Update countdown periodically every 30 seconds to keep remaining time fresh
    setInterval(function () {
        if (document.hidden) return;
        if (state.active) {
            renderSidebar();
            renderTopbar();
        }
    }, 30000);

    window.GM_SHELL = {
        gotoItem: gotoItem,
        renderShell: renderShell,
        renderSidebar: renderSidebar,
        renderTopbar: renderTopbar
    };

})();
