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
        { id: 'stats',     tabId: 'stats-admin', icon: 'ph-chart-bar',       labelKey: 'gm_nav_stats',     section: 'play',  panels: ['stats-admin'] },
        { id: 'accounts',  tabId: 'admin-home',  icon: 'ph-key',             labelKey: 'gm_nav_accounts',  section: 'admin', panels: ['admin-home'], r5Only: true },
        { id: 'sanctions', tabId: 'tab-sanctions', icon: 'ph-warning-octagon', labelKey: 'gm_nav_sanctions', section: 'admin', panels: ['tab-sanctions'] }
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
        { id: 'event-svs',          icon: 'ph-sword',        label: 'SvS' },
        { id: 'event-gvg',          icon: 'ph-flag-banner',  label: 'GvG' },
        { id: 'event-shadowfront',  icon: 'ph-ghost',        label: 'Shadowfront' },
        { id: 'event-dtr',          icon: 'ph-rocket',       label: 'DTR' },
        { id: 'event-arms-race',    icon: 'ph-target',       label: 'Arms Race' }
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

        // On crée aussi un bouton .nav-tab caché pour gm-overview pour que app.js
        // le détecte. Sinon le click programmatique de la sidebar n'aurait rien à
        // déclencher.
        var legacyNav = dashboard.querySelector('.app-header .nav-tabs');
        if (legacyNav && !legacyNav.querySelector('[data-tab="gm-overview"]')) {
            var btn = document.createElement('button');
            btn.className = 'nav-tab';
            btn.setAttribute('data-tab', 'gm-overview');
            btn.setAttribute('data-view', 'dashboard-view');
            btn.style.display = 'none';
            legacyNav.insertBefore(btn, legacyNav.firstChild);
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
        return sessionStorage.getItem('rad_user') || 'Membre';
    }
    function getUserRole() {
        return sessionStorage.getItem('rad_role') === 'admin' ? 'R5' : 'R4';
    }
    function getUserRoleLong() {
        var r = getUserRole();
        return r === 'R5' ? 'R5 · Leader' : 'R4 · Officier';
    }

    function renderSidebar() {
        var el = document.querySelector('[data-gm-sidebar]');
        if (!el) return;
        var visible = visibleNavItems();
        var playItems = visible.filter(function (i) { return i.section === 'play'; });
        var adminItems = visible.filter(function (i) { return i.section === 'admin'; });

        var html =
            '<div class="gm-sidebar-brand">' +
                '<div class="gm-brand-mark">R</div>' +
                '<div>' +
                    '<div class="gm-brand-text">' + t('gm_brand') + '</div>' +
                    '<div class="gm-brand-sub">' + t('gm_brand_sub') + '</div>' +
                '</div>' +
            '</div>' +
            '<nav class="gm-sidebar-nav">' +
                '<div class="gm-nav-section-label">' + t('gm_nav_play') + '</div>' +
                playItems.map(navItemHtml).join('') +
                '<div class="gm-nav-section-label">' + t('gm_nav_admin') + '</div>' +
                adminItems.map(navItemHtml).join('') +
            '</nav>' +
            '<div class="gm-sidebar-foot">' +
                '<div class="gm-user-avatar">' + window.RAD.escapeHTML(window.RAD.avatarInit(getUserName())) + '</div>' +
                '<div class="gm-user-meta">' +
                    '<div class="gm-user-name">' + window.RAD.escapeHTML(getUserName()) + '</div>' +
                    '<div class="gm-user-role">' + getUserRoleLong() + '</div>' +
                '</div>' +
            '</div>';
        el.innerHTML = html;

        el.querySelectorAll('[data-gm-nav-item]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                gotoItem(btn.getAttribute('data-gm-nav-item'));
            });
        });
    }

    function navItemHtml(item) {
        var isActive = state.active === item.id;
        return '<button class="gm-nav-item' + (isActive ? ' gm-active' : '') + '" data-gm-nav-item="' + item.id + '">' +
                '<i class="ph ' + item.icon + '"></i>' +
                '<span>' + t(item.labelKey) + '</span>' +
            '</button>';
    }

    function renderTopbar() {
        var el = document.querySelector('[data-gm-topbar]');
        if (!el) return;
        var current = NAV_ITEMS.find(function (i) { return i.id === state.active; });
        var title = current ? t(current.labelKey) : t('gm_brand');

        var brandHtml = state.mobile
            ? '<div class="gm-topbar-mobile-brand">' +
                '<div class="gm-brand-mark">R</div>' +
                '<div class="gm-topbar-title">' + title + '</div>' +
              '</div>'
            : '<div class="gm-topbar-title">' + title + '</div>';

        var lang = window.RAD_I18N.getLang();
        var html = brandHtml +
            '<div class="gm-topbar-actions">' +
                '<div class="gm-lang-toggle">' +
                    '<button data-gm-lang="fr" class="' + (lang === 'fr' ? 'gm-active' : '') + '">FR</button>' +
                    '<button data-gm-lang="en" class="' + (lang === 'en' ? 'gm-active' : '') + '">EN</button>' +
                '</div>' +
                '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm" data-gm-logout title="' + t('nav_logout_title') + '">' +
                    '<i class="ph ph-sign-out"></i>' +
                '</button>' +
            '</div>';
        el.innerHTML = html;

        el.querySelectorAll('[data-gm-lang]').forEach(function (b) {
            b.addEventListener('click', function () {
                window.RAD_I18N.setLang(b.getAttribute('data-gm-lang'));
                renderShell();
            });
        });
        var lo = el.querySelector('[data-gm-logout]');
        if (lo) lo.addEventListener('click', function () {
            var legacy = document.getElementById('logout-btn');
            if (legacy) legacy.click();
        });
    }

    function renderBottomNav() {
        var el = document.querySelector('[data-gm-bottom-nav]');
        if (!el) return;
        // 4 items principaux + More
        var primary = ['overview', 'members', 'events', 'stats'];
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
            html += '<button class="gm-drawer-item' + (isActive ? ' gm-active' : '') + '" data-gm-nav-item="' + item.id + '">' +
                        '<i class="ph ' + item.icon + ' gm-icon"></i>' +
                        '<span>' + t(item.labelKey) + '</span>' +
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
        // (RAD_I18N.setLang appelle déjà applyTranslations sur le DOM existant.
        // Pour notre shell, on a re-render manuellement après chaque setLang.)
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
            renderTopbar();
            if (!e.matches) closeDrawer();
        });
    }

    window.RAD_SHELL = {
        gotoItem: gotoItem,
        renderShell: renderShell
    };

})();
