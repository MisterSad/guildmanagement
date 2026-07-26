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

    if (!window.RAD) return;

    var t = window.RAD.t;
    var esc = window.RAD.escapeHTML;

    // ── Définition des items de nav ─────────────────────────────────────────
    // tabId = data-tab existant que app.js sait gérer.
    // Mapping panel-actif → item courant : on utilise `panels` pour savoir si
    // une .nav-tab.active appartient à cet item.
    var NAV_ITEMS = [
        { id: 'overview',  tabId: 'gm-overview', icon: 'ph-squares-four',    labelKey: 'gm_nav_overview',  section: 'play',  panels: ['gm-overview'] },
        { id: 'members',   tabId: 'admin-members', icon: 'ph-users',         labelKey: 'gm_nav_members',   section: 'play',  panels: ['admin-members'] },
        { id: 'events',    tabId: 'event-svs',   icon: 'ph-sword',           labelKey: 'gm_nav_events',    section: 'play',
          panels: ['event-svs', 'event-gvg', 'event-shadowfront', 'event-dtr', 'event-arms-race'] },
        { id: 'glory',     tabId: 'event-glory', icon: 'ph-trophy',          labelKey: 'gm_nav_glory',     section: 'play',  panels: ['event-glory'] },
        { id: 'history',   tabId: 'event-history', icon: 'ph-clock-counter-clockwise', labelKey: 'gm_nav_history', section: 'play',  panels: ['event-history'] },
        { id: 'stats',     tabId: 'stats-admin', icon: 'ph-chart-bar',       labelKey: 'gm_nav_stats',     section: 'play',  panels: ['stats-admin'] },
        { id: 'sanctions', tabId: 'tab-sanctions', icon: 'ph-warning-octagon', labelKey: 'gm_nav_sanctions', section: 'admin', panels: ['tab-sanctions'] },
        { id: 'accounts',  tabId: 'admin-home',  icon: 'ph-key',             labelKey: 'gm_nav_accounts',  section: 'superadmin', r5Only: true, panels: ['admin-home'] },
        { id: 'banned',    tabId: 'admin-banned', icon: 'ph-prohibit',        labelKey: 'gm_nav_banned',    section: 'superadmin', r5Only: true, panels: ['admin-banned'] }
    ];

    function visibleNavItems() {
        var role = getUserRole();
        return NAV_ITEMS.filter(function (i) { return !i.r5Only || role === 'R5'; });
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
    });

    // ── Events tabs-pill : injectée dans chaque event panel ─────────────────
    var EVENT_TABS = [
        { id: 'event-svs',          icon: 'ph-swords',       label: 'SvS' },
        { id: 'event-gvg',          icon: 'ph-flag-banner',  label: 'GvG' },
        { id: 'event-shadowfront',  icon: 'ph-ghost',        label: 'Shadowfront' },
        { id: 'event-dtr',          icon: 'ph-truck',        label: 'DTR' },
        { id: 'event-arms-race',    icon: 'ph-crosshair',    label: 'Arms Race' }
    ];

    function renderEventsTabs() {
        document.querySelectorAll('[data-gm-events-tabs]').forEach(function (slot) {
            var ownerPanel = slot.closest('.tab-panel');
            var ownerId = ownerPanel ? ownerPanel.id : '';
            var html = '<div class="gm-tabs-pill" style="margin-bottom:1rem; flex-wrap:nowrap; overflow-x:auto;">';
            EVENT_TABS.forEach(function (e) {
                var active = e.id === ownerId;
                html += '<button class="gm-tab-pill' + (active ? ' gm-active' : '') + '" data-gm-event-tab="' + e.id + '">' +
                    '<i class="ph ' + e.icon + '"></i> ' + e.label +
                '</button>';
            });
            html += '</div>';
            slot.innerHTML = html;
            slot.querySelectorAll('[data-gm-event-tab]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var tabId = btn.getAttribute('data-gm-event-tab');
                    var legacy = document.querySelector('.nav-tab[data-tab="' + tabId + '"]');
                    if (legacy) legacy.click();
                });
            });
        });
    }

    // ── Login : œil show/hide pour le password ──────────────────────────────
    function wireLoginPasswordToggle() {
        var btn = document.querySelector('[data-gm-pwd-toggle]');
        var input = document.getElementById('password');
        if (!btn || !input) return;
        btn.addEventListener('click', function () {
            var isPwd = input.type === 'password';
            input.type = isPwd ? 'text' : 'password';
            var icon = btn.querySelector('i');
            if (icon) icon.className = isPwd ? 'ph ph-eye-slash' : 'ph ph-eye';
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
                if (window.RAD_OVERVIEW) window.RAD_OVERVIEW.load();
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
    }

    function getUserName() {
        return localStorage.getItem('rad_user') || 'Membre';
    }
    function getUserRole() {
        return localStorage.getItem('rad_role') === 'admin' ? 'R5' : 'R4';
    }
    function getUserRoleLong() {
        var r = getUserRole();
        if (r === 'R5') return 'Super Admin';
        if (window.currentGuildRestriction) {
            return 'Admin ' + window.currentGuildRestriction;
        }
        return 'Admin';
    }

    function checkSubscriptionStatus() {
        var isSuperAdmin = (localStorage.getItem('rad_role') === 'admin');
        var isExpired = false;
        var activeGuild = window.currentGuild || 'ALPHA';
        if (window.guildsData && window.guildsData[activeGuild]) {
            var sub = window.guildsData[activeGuild];
            if (sub.type === 'Premium') {
                if (sub.end) {
                    var diff = new Date(sub.end).getTime() - Date.now();
                    if (diff <= 0) isExpired = true;
                } else {
                    isExpired = true;
                }
            }
        }

        var readOnlyActive = isExpired && !isSuperAdmin;
        var banner = document.getElementById('guild-warning-banner');

        if (readOnlyActive) {
            document.body.classList.add('guild-read-only');
            if (banner) {
                banner.innerHTML = '<i class="ph-fill ph-warning-octagon" style="font-size: 1.2rem;"></i>' +
                    '<span><strong>Read-only access:</strong> The subscription for this guild has expired. Data modification is disabled.</span>';
                banner.style.display = 'flex';
            }
        } else {
            document.body.classList.remove('guild-read-only');
            if (banner) {
                banner.style.display = 'none';
                banner.innerHTML = '';
            }
        }
        return isExpired;
    }

    function renderGuildSelectorHtml() {
        var isSuperAdmin = (localStorage.getItem('rad_role') === 'admin');
        var guilds = window.guildsList || ['ALPHA', 'OMEGA', 'IMK'];
        if (window.currentGuildRestriction) {
            guilds = [window.currentGuildRestriction];
            window.currentGuild = window.currentGuildRestriction;
            localStorage.setItem('rad_current_guild', window.currentGuildRestriction);
        }

        if (isSuperAdmin && !window.currentGuildRestriction) {
            var guildOptions = guilds.map(function(g) {
                return '<option value="' + g + '"' + (window.currentGuild === g ? ' selected' : '') + '>' + esc(g) + ' Guild</option>';
            }).join('');
            return '<div class="gm-sidebar-guild-select-wrapper">' +
                '<select class="gm-sidebar-guild-select" data-gm-guild-select>' +
                    guildOptions +
                '</select>' +
            '</div>';
        } else {
            var displayGuild = window.currentGuildRestriction || window.currentGuild || 'ALPHA';
            return '<div class="gm-sidebar-guild-badge">' + esc(displayGuild) + ' Guild</div>';
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
            '<div class="gm-sub-card-badge-avatar">' +
                '<i class="ph-fill ' + icon + '"></i>' +
            '</div>' +
            '<div class="gm-sub-card-title">' + cardTitle + '</div>' +
            '<div class="gm-sub-card-subtext">' + cardDesc + '</div>' +
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

        var visible = visibleNavItems();
        var playItems = visible.filter(function (i) { return i.section === 'play'; });
        var adminItems = visible.filter(function (i) { return i.section === 'admin'; });
        var superAdminItems = visible.filter(function (i) { return i.section === 'superadmin'; });

        var userAvatarInitials = esc(window.RAD.avatarInit(getUserName()));

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
                        '<i class="ph ph-sign-out"></i>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<nav class="gm-sidebar-nav">' +
                navHtml +
            '</nav>' +
            getSubscriptionCardHtml();

        el.innerHTML = html;

        el.querySelectorAll('[data-gm-nav-item]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                gotoItem(btn.getAttribute('data-gm-nav-item'));
            });
        });

        var gSel = el.querySelector('[data-gm-guild-select]');
        if (gSel) {
            gSel.addEventListener('change', function () {
                var newGuild = gSel.value;
                localStorage.setItem('rad_current_guild', newGuild);
                window.currentGuild = newGuild;
                renderSidebar();
                renderTopbar();
                if (window.RAD_APP && window.RAD_APP.reloadActiveView) {
                    window.RAD_APP.reloadActiveView();
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
        var icon = item.icon;

        return '<button class="gm-nav-item' + (isActive ? ' gm-active' : '') + '" data-gm-nav-item="' + item.id + '">' +
                '<i class="ph ' + icon + '"></i>' +
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

        var isSuperAdmin = (localStorage.getItem('rad_role') === 'admin');

        var guilds = window.guildsList || ['ALPHA', 'OMEGA', 'IMK'];
        if (window.currentGuildRestriction) {
            guilds = [window.currentGuildRestriction];
            window.currentGuild = window.currentGuildRestriction;
            localStorage.setItem('rad_current_guild', window.currentGuildRestriction);
        }
        var guildOptions = guilds.map(function(g) {
            return '<option value="' + g + '"' + (window.currentGuild === g ? ' selected' : '') + '>' + g + '</option>';
        }).join('');

        var selectStyle = isSuperAdmin
            ? 'padding: 0.35rem 0.8rem; font-size: 0.85rem; font-weight: 600; border-radius: 6px; background: var(--bg-soft); border: 1px solid var(--border-soft); color: var(--text-main); cursor: pointer; outline: none; transition: border-color 0.2s;'
            : 'display: none; padding: 0.35rem 0.8rem; font-size: 0.85rem; font-weight: 600; border-radius: 6px; background: var(--bg-soft); border: 1px solid var(--border-soft); color: var(--text-main); cursor: pointer; outline: none; transition: border-color 0.2s;';

        var html = brandHtml +
            '<div class="gm-topbar-actions">' +
                '<select id="guild-selector" class="gm-select" style="' + selectStyle + '">' +
                    guildOptions +
                '</select>' +
                '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm" data-gm-logout title="' + t('nav_logout_title') + '">' +
                    '<i class="ph ph-sign-out"></i>' +
                '</button>' +
            '</div>';
        el.innerHTML = html;

        var gs = el.querySelector('#guild-selector');
        if (gs) {
            gs.addEventListener('change', function () {
                var newGuild = gs.value;
                localStorage.setItem('rad_current_guild', newGuild);
                window.currentGuild = newGuild;
                
                // Re-render topbar & sidebar immediately to update subscription status and card!
                renderSidebar();
                renderTopbar();
                
                if (window.RAD_APP && window.RAD_APP.reloadActiveView) {
                    window.RAD_APP.reloadActiveView();
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
            html += '<button class="gm-bottom-nav-item' + (isActive ? ' gm-active' : '') + '" data-gm-nav-item="' + id + '">' +
                        '<i class="ph ' + item.icon + ' gm-icon"></i>' +
                        '<span>' + t(item.labelKey) + '</span>' +
                    '</button>';
        });
        html += '<button class="gm-bottom-nav-item" data-gm-more>' +
                    '<i class="ph ph-dots-three-outline gm-icon"></i>' +
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
    }

    function renderDrawer() {
        var drawer = document.querySelector('[data-gm-drawer]');
        var backdrop = document.querySelector('[data-gm-drawer-backdrop]');
        if (!drawer || !backdrop) return;

        var html = '<div class="gm-drawer-handle"></div><div class="gm-drawer-grid">';
        visibleNavItems().forEach(function (item) {
            var isActive = state.active === item.id;
            var label = t(item.labelKey);
            var icon = item.icon;

            html += '<button class="gm-drawer-item' + (isActive ? ' gm-active' : '') + '" data-gm-nav-item="' + item.id + '">' +
                        '<i class="ph ' + icon + ' gm-icon"></i>' +
                        '<span>' + label + '</span>' +
                    '</button>';
        });
        html += '</div>';
        drawer.innerHTML = html;

        drawer.querySelectorAll('[data-gm-nav-item]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                gotoItem(btn.getAttribute('data-gm-nav-item'));
                closeDrawer();
            });
        });
        backdrop.addEventListener('click', closeDrawer);
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
        var legacyTab = document.querySelector('.nav-tab[data-tab="' + item.tabId + '"]');
        if (legacyTab) legacyTab.click();
        // Le MutationObserver s'occupe de mettre à jour notre état actif.
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
            if (!item || item.id === state.active) return;
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
        if (state.active) {
            renderSidebar();
            renderTopbar();
        }
    }, 30000);

    window.RAD_SHELL = {
        gotoItem: gotoItem,
        renderShell: renderShell,
        renderSidebar: renderSidebar,
        renderTopbar: renderTopbar
    };

})();
