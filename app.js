/**
 * app.js — Cœur de l'application : sessions, comptes, membres, navigation
 * et handlers globaux du dashboard. Charge les modules métier (stats,
 * sanctions, overview, …) à la demande selon l'onglet actif.
 */
(function () {

    function t(key) { return window.GM_I18N.t(key); }
    var supabase = window.GM ? window.GM.db : null;
    var esc = window.GM ? window.GM.escapeHTML : function (s) { return s; };

    // ─── DOM References ───────────────────────────────────────────────────────
    var loginView         = document.getElementById('login-view');
    var dashboardView     = document.getElementById('dashboard-view');
    var memberView        = document.getElementById('member-view');
    var loginForm         = document.getElementById('login-form');
    var loginError        = document.getElementById('login-error');
    var registerForm      = document.getElementById('register-form');
    var registerError     = document.getElementById('register-error');
    var logoutBtn         = document.getElementById('logout-btn');
    var memberLogoutBtn   = document.getElementById('member-logout-btn');
    var createAccountForm = document.getElementById('create-account-form');
    var accountList       = document.getElementById('account-list');
    var accountCount      = document.getElementById('account-count');
    var toastContainer    = document.getElementById('toast-container');
    var addMemberForm     = document.getElementById('add-member-form');
    var guildMemberList   = document.getElementById('guild-member-list');
    var guildMemberCount  = document.getElementById('guild-member-count');
    var addMemberFormM    = document.getElementById('add-member-form-member');
    var guildMemberListM  = document.getElementById('guild-member-list-m');
    var guildMemberCountM = document.getElementById('guild-member-count-m');
    var addBannedForm     = document.getElementById('add-banned-form');
    var bannedListContainer = document.getElementById('banned-list-container');
    var bannedCount       = document.getElementById('banned-count');
    var bannedSearch      = document.getElementById('banned-search');

    // ─── State ────────────────────────────────────────────────────────────────
    var accounts      = [];
    var guildMembers  = [];
    var bannedPlayers = [];
    window.GM_COLLAPSED_ROLES = { R5: false, R4: false, R3: false, R2: false, R1: false };

    // ─── Boot ─────────────────────────────────────────────────────────────────
    window.GM_I18N.applyTranslations();

    // Restaure depuis la session Supabase persistée (survit au rechargement
    // et à la fermeture d'onglet tant que le refresh token est valide).
    (async function restoreSession() {
        var localRole = localStorage.getItem('gm_role');
        var localUser = localStorage.getItem('gm_user');
        var portalSession = localStorage.getItem('gm_portal_session') === '1';

        // Avoid insecure flash of admin dashboard before cryptographic JWT verification
        if (localRole || localUser) {
            loginView.classList.add('hidden');
        }

        var info = await window.GM.sessionInfo();
        if (!info) {
            // supabase-js could not restore the session on reload: try a manual
            // refresh-token exchange against GoTrue and re-inject the session.
            info = await window.GM.forceRefreshPortalSession();
        }
        if (!info) {
            // Si pas de session valide Supabase mais qu'on avait des infos locales, on force la déconnexion
            if (localRole || localUser) {
                doLogout();
            }
            return;
        }

        // Player-portal session: restore the portal directly, full page.
        if (portalSession && info.role === 'member') {
            localStorage.setItem('gm_role', 'member');
            if (info.accountId) {
                localStorage.setItem('gm_user', info.accountId);
                window.GM.currentAccountId = info.accountId;
            }
            window.currentGuildRestriction = null;
            localStorage.removeItem('gm_guild_restriction');

            loginView.classList.add('hidden');
            if (memberView) memberView.classList.add('hidden');
            dashboardView.classList.add('hidden');
            dashboardView.classList.remove('active');
            playerPortalView.classList.remove('hidden');
            portalStepLookup.classList.add('hidden');
            portalStepForm.classList.remove('hidden');
            playerPortalView.classList.add('portal-connected');
            var portalContainer = document.querySelector('.gm-portal-container');
            if (portalContainer) portalContainer.classList.add('portal-wide');
            if (window.GM_PORTAL) {
                window.GM_PORTAL.loadDashboard();
            }
            return;
        }

        // Non-portal session: clear the portal marker.
        localStorage.removeItem('gm_portal_session');

        // Fetch guild restriction if guild_admin
        if (info.role === 'guild_admin' && info.accountId) {
            try {
                var { data } = await supabase.from('accounts').select('guild').ilike('id', info.accountId).maybeSingle();
                if (data && data.guild) {
                    window.currentGuildRestriction = data.guild;
                    window.currentGuild = data.guild;
                    localStorage.setItem('gm_current_guild', data.guild);
                    localStorage.setItem('gm_guild_restriction', data.guild);
                } else {
                    window.currentGuildRestriction = null;
                    localStorage.removeItem('gm_guild_restriction');
                }
            } catch (err) {
                console.error('Failed to restore account guild restriction:', err);
                window.currentGuildRestriction = null;
                localStorage.removeItem('gm_guild_restriction');
            }
        } else {
            window.currentGuildRestriction = null;
            localStorage.removeItem('gm_guild_restriction');
        }

        var role = info.role; // already normalized (super_admin | guild_admin | member)
        localStorage.setItem('gm_role', role);
        if (info.accountId) {
            localStorage.setItem('gm_user', info.accountId);
            // Store in memory for reliable access (not manipulable via DevTools without logout)
            window.GM.currentAccountId = info.accountId;
        }

        // Defensive: make sure a guild_admin always has a guild restriction
        // loaded before any write can happen (see canWriteGuild).
        if (role === 'guild_admin' && window.GM.ensureGuildRestriction) {
            await window.GM.ensureGuildRestriction();
        }

        // Fetch guilds list (now authenticated, query will succeed)
        await fetchGuilds();

        // Always update the dashboard and shell to reflect fresh authenticated data
        showAdminDashboard(role);
        if (role !== 'member' && window.GM_SHELL && window.GM_SHELL.renderShell) {
            window.GM_SHELL.renderShell();
        }
        reloadActiveView();

        // Handle a Stripe checkout redirect (back from the hosted payment
        // page): switch to the Subscription tab so GM_SUBSCRIPTION.load()
        // can poll gm-order-status and confirm the payment. The URL is
        // cleaned right away so a later page refresh does not force this tab
        // again (the checkout params would otherwise stay in the address bar).
        var urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('checkout') === 'success' || urlParams.get('checkout') === 'cancel') {
            if (window.GM_SUBSCRIPTION && window.GM_SHELL && window.GM_SHELL.gotoItem) {
                window.GM_SHELL.gotoItem('subscription');
            }
            try {
                window.history.replaceState({}, '', window.location.pathname + window.location.hash);
            } catch (e) { /* non fatal */ }
        }
    })();

    // ─── Auth ─────────────────────────────────────────────────────────────────
    loginForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var user = document.getElementById('username').value.trim();
        var pass = document.getElementById('password').value;

        var btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        var span = btn.querySelector('span');
        if (span) span.textContent = t('login_btn_loading');

        try {
            var resp = await window.GM.login(user, pass);

            if (resp.ok) {
                var canonicalUser = resp.id || user;
                loginError.classList.add('hidden');
                document.getElementById('password').value = '';

                // Fetch guilds list
                await fetchGuilds();

                // Fetch guild restriction for new logins if guild_admin
                if (window.GM.normalizeRole(resp.role) === 'guild_admin') {
                    try {
                        var { data } = await supabase.from('accounts').select('guild').ilike('id', canonicalUser).maybeSingle();
                        if (data && data.guild) {
                            window.currentGuildRestriction = data.guild;
                            window.currentGuild = data.guild;
                            localStorage.setItem('gm_current_guild', data.guild);
                            localStorage.setItem('gm_guild_restriction', data.guild);
                        } else {
                            window.currentGuildRestriction = null;
                            localStorage.removeItem('gm_guild_restriction');
                        }
                    } catch (err) {
                        console.error('Failed to load login guild restriction:', err);
                        window.currentGuildRestriction = null;
                        localStorage.removeItem('gm_guild_restriction');
                    }
                } else {
                    window.currentGuildRestriction = null;
                    localStorage.removeItem('gm_guild_restriction');
                }

                var role = window.GM.normalizeRole(resp.role);
                localStorage.setItem('gm_role', role);
                localStorage.setItem('gm_user', canonicalUser);
                // Store in memory for reliable access
                window.GM.currentAccountId = canonicalUser;

                showAdminDashboard(role);
                if (role !== 'member' && window.GM_SHELL && window.GM_SHELL.renderShell) {
                    window.GM_SHELL.renderShell();
                }
                showToast(role === 'super_admin' ? t('toast_login_ok') : (t('toast_welcome') + ' ' + user + ' !'), 'success');
            } else if (resp.error === 'pending_approval') {
                loginError.classList.remove('hidden');
                var pe = loginError.querySelector('span');
                if (pe) pe.textContent = 'Your account is awaiting approval by a guild admin.';
            } else if (resp && resp.error === 'invalid_credentials') {
                loginError.classList.remove('hidden');
                var pe = loginError.querySelector('span');
                if (pe) pe.textContent = t('login_error');
            } else {
                loginError.classList.remove('hidden');
                var pe = loginError.querySelector('span');
                if (pe) pe.textContent = (resp && resp.error) ? resp.error : t('login_error');
            }
        } catch (err) {
            console.error('Login error details:', err);
            loginError.classList.remove('hidden');
            var pe = loginError.querySelector('span');
            if (pe && err && err.message) pe.textContent = err.message;
            var card = document.querySelector('.login-card');
            if (card) {
                card.style.animation = 'none';
                void card.offsetHeight;
                card.style.animation = 'shake 0.4s ease-in-out';
            }
        } finally {
            btn.disabled = false;
            if (span) span.textContent = t('login_btn');
        }
    });

    if (logoutBtn)       logoutBtn.addEventListener('click', doLogout);

    // ─── Player self-registration ────────────────────────────────────────────
    var goToRegisterBtn = document.getElementById('go-to-register-btn');
    var registerBackBtn = document.getElementById('register-back-btn');
    var loginCard       = document.querySelector('#login-form');
    var loginHero       = document.querySelector('.gm-login-hero-tag');

    function showRegisterForm(show) {
        if (registerForm) registerForm.classList.toggle('hidden', !show);
        if (loginForm) loginForm.classList.toggle('hidden', show);
        if (loginHero) loginHero.classList.toggle('hidden', show);
        if (registerError) registerError.classList.add('hidden');
    }

    if (goToRegisterBtn) goToRegisterBtn.addEventListener('click', function () { showRegisterForm(true); });
    if (registerBackBtn) registerBackBtn.addEventListener('click', function () { showRegisterForm(false); });

    if (registerForm) registerForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var id = document.getElementById('register-id').value.trim();
        var pass = document.getElementById('register-password').value;
        var uid = document.getElementById('register-uid').value.trim();
        var code = document.getElementById('register-code').value.trim();

        var btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        var span = btn.querySelector('span');
        if (span) span.textContent = 'Submitting...';

        try {
            var resp = await window.GM.registerPlayer(id, pass, uid, code);
            if (resp.ok) {
                if (registerError) registerError.classList.add('hidden');
                if (registerForm) registerForm.reset();
                showRegisterForm(false);
                showToast('Registration submitted. A guild admin will approve your account.', 'success');
            } else {
                var msg = {
                    invalid_identifier: 'Identifier must be 3 to 32 characters.',
                    weak_password: 'Password must be at least 8 characters.',
                    invalid_uid: 'Invalid in-game UID.',
                    invalid_code: 'Invalid guild join code.',
                    uid_not_in_guild: 'This UID is not a member of the guild for this join code.',
                    uid_already_claimed: 'This UID is already linked to an account.',
                    identifier_taken: 'This identifier is already taken.',
                    too_many_attempts: 'Too many attempts. Try again later.',
                    request_failed: 'Network error. Please try again.'
                }[resp.error] || 'Registration failed. Please try again.';
                if (registerError) {
                    registerError.classList.remove('hidden');
                    var regMsg = registerError.querySelector('span');
                    if (regMsg) regMsg.textContent = msg;
                }
            }
        } catch (err) {
            console.error('Registration error details:', err);
            if (registerError) registerError.classList.remove('hidden');
        } finally {
            btn.disabled = false;
            if (span) span.textContent = 'Create account';
        }
    });
    if (memberLogoutBtn) memberLogoutBtn.addEventListener('click', doLogout);

    function doLogout() {
        window.GM.logout();
        localStorage.removeItem('gm_role');
        localStorage.removeItem('gm_user');
        localStorage.removeItem('gm_current_guild');
        localStorage.removeItem('gm_guild_restriction');
        localStorage.removeItem('gm_portal_session');
        window.currentGuildRestriction = null;
        showLogin();
        showToast(t('toast_logout'), 'info');
    }

    // ─── View Switching ───────────────────────────────────────────────────────
    function showAdminDashboard(role) {
        role = window.GM.normalizeRole(role || localStorage.getItem('gm_role'));
        loginView.classList.add('hidden');

        // Player accounts never see the admin dashboard: open the Player Portal.
        if (role === 'member') {
            dashboardView.classList.add('hidden');
            dashboardView.classList.remove('active');
            if (memberView) memberView.classList.add('hidden');
            localStorage.setItem('gm_portal_session', '1');
            playerPortalView.classList.remove('hidden');
            portalStepLookup.classList.add('hidden');
            portalStepForm.classList.remove('hidden');
            playerPortalView.classList.add('portal-connected');
            var portalContainer = document.querySelector('.gm-portal-container');
            if (portalContainer) portalContainer.classList.add('portal-wide');
            if (window.GM_PORTAL) {
                window.GM_PORTAL.loadDashboard();
            }
            return;
        }

        if (memberView) memberView.classList.add('hidden');
        dashboardView.classList.remove('hidden');
        dashboardView.classList.add('active');

        var adminHomeBtn = document.querySelector('.nav-tab[data-tab="admin-home"]');
        var roleLabel = document.getElementById('nav-user-role');
        var nameLabel = document.getElementById('nav-user-name');

        var isR5 = (role !== 'member'); // super_admin & guild_admin

        if (isR5) {
            renderGuildsSubscriptionList();
        }

        populateAccountGuildSelect();

        var systemLogsTabBtn = document.getElementById('nav-tab-system-logs');
        if (systemLogsTabBtn) {
            if (role === 'super_admin') {
                systemLogsTabBtn.classList.remove('hidden');
            } else {
                systemLogsTabBtn.classList.add('hidden');
            }
        }

        if (role !== 'super_admin') { // guild_admin or member
            if (roleLabel) {
                roleLabel.textContent = window.currentGuildRestriction 
                    ? 'Admin ' + window.currentGuildRestriction + ' :' 
                    : 'Admin :';
            }
            if (nameLabel) nameLabel.textContent = localStorage.getItem('gm_user') || 'Officier';

            loadGuildSettings();
            fetchAccounts();
            fetchGuildMembers();
        } else { // super_admin
            if (roleLabel) {
                roleLabel.textContent = 'Super Admin :';
            }
            if (nameLabel) nameLabel.textContent = localStorage.getItem('gm_user') || 'Leader';

            fetchAccounts();
            loadGuildSettings();
            fetchGuildMembers();
        }
        var savedTab = localStorage.getItem('gm_active_tab') || 'overview';
        restoreSavedTab(savedTab);
    }

    // FIX (A2): Use setTimeout with fixed delay instead of requestAnimationFrame polling
    // RAF polls up to 30 times per frame (60fps = every 16ms), setTimeout spaces out retries.
    function restoreSavedTab(itemId, attempts) {
        attempts = attempts == null ? 30 : attempts;
        if (window.GM_SHELL && window.GM_SHELL.gotoItem) {
            window.GM_SHELL.gotoItem(itemId);
            return;
        }
        if (attempts <= 0) return;
        setTimeout(function () { restoreSavedTab(itemId, attempts - 1); }, 50);
    }

    function showLogin() {
        dashboardView.classList.add('hidden');
        dashboardView.classList.remove('active');
        if (memberView) { memberView.classList.add('hidden'); memberView.classList.remove('active'); }
        loginView.classList.remove('hidden');
        loginView.classList.add('active');
    }

    function triggerTabDataLoad(tabId) {
        if (!tabId) return;
        if (tabId === 'admin-members' || tabId === 'member-members' || tabId === 'member-home') {
            fetchGuildMembers();
        }
        if (tabId === 'admin-home') {
            fetchAccounts();
            loadGuildSettings();
            populateAccountGuildSelect();
            wireJoinCode();
        }
        if (tabId === 'admin-discord') {
            loadGuildSettings();
        }
        if (tabId === 'admin-superadmin') {
            renderGuildsSubscriptionList();
            fetchAccounts();
            populateAccountGuildSelect();
        }
        if (tabId === 'admin-banned') {
            fetchBannedPlayers();
        }
        if (tabId === 'tab-subscription' && window.GM_SUBSCRIPTION) {
            window.GM_SUBSCRIPTION.load();
        }
        if (tabId === 'tab-settings' && window.GM_SETTINGS) {
            window.GM_SETTINGS.load();
        }
        if ((tabId === 'tab-svs-matchup' || tabId === 'svs-matchup') && window.GM_SVS_MATCHUP) {
            window.GM_SVS_MATCHUP.load();
        }
        if ((tabId === 'tab-gvg-matchup' || tabId === 'gvg-matchup') && window.GM_GVG_MATCHUP) {
            window.GM_GVG_MATCHUP.load();
        }
        if ((tabId === 'tab-sanctions' || tabId === 'sanctions') && window.GM_SANCTIONS) {
            window.GM_SANCTIONS.load();
        }
        if ((tabId === 'gm-overview' || tabId === 'overview') && window.GM_OVERVIEW) {
            window.GM_OVERVIEW.load();
        }
        if ((tabId === 'event-svs' || tabId === 'svs') && window.GM_EVENTS) {
            window.GM_EVENTS.loadEvent('SvS');
        }
        if ((tabId === 'event-gvg' || tabId === 'gvg') && window.GM_EVENTS) {
            window.GM_EVENTS.loadEvent('GvG');
        }
        if ((tabId === 'event-shadowfront' || tabId === 'Shadowfront' || tabId === 'shadowfront') && window.GM_SHADOWFRONT) {
            window.GM_SHADOWFRONT.load();
        }
        if ((tabId === 'event-dtr' || tabId === 'dtr') && window.GM_EVENTS) {
            window.GM_EVENTS.loadEvent('Defend Trade Route');
        }
        if ((tabId === 'event-arms-race' || tabId === 'ARMS RACE' || tabId === 'Arms Race' || tabId === 'armsrace') && window.GM_ARMSRACE) {
            window.GM_ARMSRACE.load();
        }
        if ((tabId === 'event-glory' || tabId === 'glory') && window.GM_GLORY) {
            window.GM_GLORY.load();
        }
        if ((tabId === 'event-history' || tabId === 'history') && window.GM_HISTORY) {
            window.GM_HISTORY.load();
        }
        if ((tabId === 'stats-admin' || tabId === 'stats-member' || tabId === 'stats') && window.GM_STATS) {
            window.GM_STATS.load();
        }
        if ((tabId === 'tab-system-logs' || tabId === 'system-logs') && window.GM_AUDIT) {
            window.GM_AUDIT.loadLogs();
        }
    }

    window.GM_APP = window.GM_APP || {};
    window.GM_APP.onTabActivated = function (tabId) {
        triggerTabDataLoad(tabId);
    };

    // ─── Tab Navigation ───────────────────────────────────────────────────────
    document.querySelectorAll('.nav-tab').forEach(function (tabBtn) {
        tabBtn.addEventListener('click', function () {
            var tabId  = tabBtn.getAttribute('data-tab');
            var viewId = tabBtn.getAttribute('data-view');
            var viewEl = document.getElementById(viewId);

            if (viewEl) {
                viewEl.querySelectorAll('.nav-tab').forEach(function (b) { b.classList.remove('active'); });
                tabBtn.classList.add('active');

                viewEl.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
                var panel = document.getElementById(tabId);
                if (panel) panel.classList.add('active');
            }

            window.GM_APP.onTabActivated(tabId);
        });
    });

    // ─── Password Generator ───────────────────────────────────────────────────
    // FIX (C3): Use crypto.getRandomValues() instead of Math.random() for password generation.
    // Math.random() is not cryptographically secure and produces predictable outputs.
    function generatePassword(length) {
        var chars = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ!@#$%';
        var result = '';
        var limit = 256 - (256 % chars.length);
        while (result.length < length) {
            var values = new Uint8Array(length * 2);
            crypto.getRandomValues(values);
            for (var i = 0; i < values.length && result.length < length; i++) {
                if (values[i] < limit) {
                    result += chars[values[i] % chars.length];
                }
            }
        }
        return result;
    }

    // In-memory cache for passwords of freshly created accounts.
    // Cleared on page reload. Avoids storing passwords in the DOM.
    var pendingPasswords = {};

    // ─── Accounts CRUD ────────────────────────────────────────────────────────
    async function fetchAccounts() {
        if (!supabase) return;
        try {
            var res = await window.GM.adminAccounts('list');
            if (!res.ok) throw new Error(res.error || 'list_failed');
            accounts = res.accounts || [];

            renderAccounts();
            // Accounts may resolve after members; re-render so the portal
            // badge on member tiles is up to date.
            if (guildMembers.length > 0) renderGuildMembers();
        } catch (err) {
            showToast(t('toast_err_fetch_accounts') + ' ' + err.message, 'error');
        }
    }

    if (createAccountForm) {
        createAccountForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var idInput    = document.getElementById('account-id');
            var identifier = idInput.value.trim();
            if (!identifier) return;

            var guildInput = document.getElementById('account-guild');
            var guildSelected = guildInput ? guildInput.value : 'ALL';

            if (accounts.some(function (a) { return a.id.toLowerCase() === identifier.toLowerCase(); })) {
                showToast(t('toast_duplicate_account'), 'error');
                return;
            }

            var btn = e.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            var span = btn.querySelector('span');
            if (span) span.textContent = t('btn_generating');

            var newPassword = generatePassword(12);
            try {
                var res = await window.GM.adminAccounts('create', {
                    id: identifier,
                    password: newPassword,
                    role: 'guild_admin',
                    guild: (guildSelected === 'ALL' ? null : guildSelected),
                    created_by: window.GM.currentAccountId
                });
                if (!res.ok) throw new Error(res.error || 'create_failed');

                pendingPasswords[identifier] = newPassword;
                accounts.unshift({ 
                    id: identifier, 
                    role: 'guild_admin', 
                    guild: (guildSelected === 'ALL' ? null : guildSelected), 
                    created_at: new Date().toISOString() 
                });
                renderAccounts();
                idInput.value = '';
                showToast(t('toast_account_created'), 'success');
            } catch (err) {
                showToast(err.message || t('toast_err_create'), 'error');
            } finally {
                btn.disabled = false;
                if (span) span.textContent = t('btn_generate');
            }
        });
    }

    async function deleteAccount(id) {
        try {
            var res = await window.GM.adminAccounts('delete', { id: id });
            if (!res.ok) throw new Error(res.error || 'delete_failed');
            accounts = accounts.filter(function (a) { return a.id !== id; });
            renderAccounts();
            showToast(t('toast_account_deleted'), 'success');
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    async function fetchGuilds() {
        if (!supabase) return;
        try {
            var res = await supabase.from('guilds').select('id, subscription_type, subscription_end, server_number, payments_disabled').order('id');
            if (res.error) {
                return;
            }
            var data = res.data;
            if (data && data.length > 0) {
                window.guildsList = data.map(function (g) { return g.id; });
                
                // Save subscription & server number info
                window.guildsData = {};
                data.forEach(function (g) {
                    var sNum = g.server_number || localStorage.getItem('gm_server_number_' + g.id) || '';
                    window.guildsData[g.id] = {
                        type: g.subscription_type || 'Unlimited',
                        end: g.subscription_end || null,
                        server_number: sNum,
                        paymentsDisabled: !!g.payments_disabled
                    };
                });
                console.log('window.guildsData populated:', window.guildsData);
                
                // Re-render topbar & sidebar if shell is loaded
                if (window.GM_SHELL) {
                    if (window.GM_SHELL.renderTopbar) window.GM_SHELL.renderTopbar();
                    if (window.GM_SHELL.renderSidebar) window.GM_SHELL.renderSidebar();
                }
                
                // Update account creation select
                populateAccountGuildSelect();
            }
        } catch (err) {
            console.error('Failed to fetch guilds list', err);
        }
    }

    function populateAccountGuildSelect() {
        var selectR4 = document.getElementById('account-guild');
        if (selectR4) {
            var myGuild = window.currentGuildRestriction || window.currentGuild || 'ALPHA';
            selectR4.innerHTML = '<option value="' + esc(myGuild) + '">' + esc(myGuild) + '</option>';
            selectR4.value = myGuild;
            selectR4.disabled = true;
        }

        var selectR5 = document.getElementById('superadmin-account-guild');
        if (selectR5) {
            var html = '';
            (window.guildsList || []).forEach(function (g) {
                var sNum = (window.guildsData && window.guildsData[g] && window.guildsData[g].server_number) ? ' (#' + window.guildsData[g].server_number + ')' : '';
                html += '<option value="' + esc(g) + '">' + esc(g) + sNum + '</option>';
            });
            selectR5.innerHTML = html;
        }
    }

    var createAdminAccountForm = document.getElementById('create-admin-account-form');
    if (createAdminAccountForm) {
        createAdminAccountForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var idInput = document.getElementById('superadmin-account-id');
            var identifier = idInput ? idInput.value.trim() : '';
            if (!identifier) return;

            var guildInput = document.getElementById('superadmin-account-guild');
            var guildSelected = guildInput ? guildInput.value : null;

            if (accounts.some(function (a) { return a.id.toLowerCase() === identifier.toLowerCase(); })) {
                showToast(t('toast_duplicate_account'), 'error');
                return;
            }

            var btn = e.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            var span = btn.querySelector('span');
            var origText = span ? span.textContent : '';
            if (span) span.textContent = 'Creating...';

            var newPassword = generatePassword(12);
            try {
                var res = await window.GM.adminAccounts('create', {
                    id: identifier,
                    password: newPassword,
                    role: 'guild_admin',
                    guild: guildSelected
                });
                if (!res.ok) throw new Error(res.error || 'create_failed');

                // Store password in memory cache (not in DOM) right after creation.
                pendingPasswords[identifier] = newPassword;
                accounts.unshift({ 
                    id: identifier, 
                    role: 'guild_admin', 
                    guild: guildSelected, 
                    created_at: new Date().toISOString() 
                });
                renderAccounts();
                if (idInput) idInput.value = '';
                showToast('Admin account ' + identifier + ' created for guild ' + guildSelected + '!', 'success');
            } catch (err) {
                showToast(err.message || 'Error creating admin account', 'error');
            } finally {
                btn.disabled = false;
                if (span) span.textContent = origText;
            }
        });
    }

    var createGuildForm = document.getElementById('create-guild-form');
    if (createGuildForm) {
        createGuildForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var nameInput = document.getElementById('guild-name-input');
            var serverInput = document.getElementById('guild-server-input');
            var guildName = nameInput ? nameInput.value.trim().toUpperCase() : '';
            var serverNum = serverInput ? serverInput.value.trim() : '';

            if (!guildName) return;

            // Server number validation: 4 digits
            if (!/^\d{4}$/.test(serverNum)) {
                showToast('Server number must be exactly 4 digits (e.g. 1089).', 'error');
                return;
            }

            if (/[^A-Z0-9_]/.test(guildName)) {
                showToast('Guild name must contain uppercase letters, numbers, or underscores.', 'error');
                return;
            }

            if ((window.guildsList || []).indexOf(guildName) !== -1) {
                showToast('This guild already exists!', 'error');
                return;
            }

            var btn = e.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            var span = btn.querySelector('span');
            var origText = span ? span.textContent : '';
            if (span) span.textContent = 'Creating...';

            try {
                var { error } = await supabase.from('guilds').insert({
                    id: guildName,
                    server_number: serverNum
                });
                if (error) throw error;
                
                showToast('Guild ' + guildName + ' (Server #' + serverNum + ') created successfully!', 'success');
                if (nameInput) nameInput.value = '';
                if (serverInput) serverInput.value = '';
                await fetchGuilds();
            } catch (err) {
                showToast('Error creating guild: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                if (span) span.textContent = origText;
            }
        });
    }

    async function loadGuildSettings() {
        var form = document.getElementById('guild-settings-form');
        if (!form) return;

        var showCalamityGvgSvs = (await window.GM.config.get('gvg_svs_calamity_enabled')) !== 'false';
        var calamityGroup = document.getElementById('notification-group-calamity');
        var gvgGroup = document.getElementById('notification-group-gvg');
        var svsGroup = document.getElementById('notification-group-svs');
        if (calamityGroup) calamityGroup.style.display = showCalamityGvgSvs ? '' : 'none';
        if (gvgGroup) gvgGroup.style.display = showCalamityGvgSvs ? '' : 'none';
        if (svsGroup) svsGroup.style.display = showCalamityGvgSvs ? '' : 'none';

        var coeffSvs = await window.GM.config.get('coeff_svs');
        var coeffGvg = await window.GM.config.get('coeff_gvg');
        var coeffShadowfront = await window.GM.config.get('coeff_shadowfront');
        var coeffDtr = await window.GM.config.get('coeff_dtr');
        var coeffArmsrace = await window.GM.config.get('coeff_armsrace');

        // Webhooks configuration
        var webhookArmsrace = await window.GM.config.get('webhook_armsrace');
        var webhookDtr = await window.GM.config.get('webhook_dtr');
        var webhookShadowfront = await window.GM.config.get('webhook_shadowfront');
        var webhookCalamity = await window.GM.config.get('webhook_calamity');
        var webhookGvg = await window.GM.config.get('webhook_gvg');
        var webhookSvs = await window.GM.config.get('webhook_svs');
        var discordRoleId = await window.GM.config.get('discord_role_id');
        var discordRoleIdArmsrace = await window.GM.config.get('discord_role_id_armsrace');
        var discordRoleIdDtr = await window.GM.config.get('discord_role_id_dtr');
        var discordRoleIdShadowfront = await window.GM.config.get('discord_role_id_shadowfront');
        var discordRoleIdCalamity = await window.GM.config.get('discord_role_id_calamity');
        var discordRoleIdGvg = await window.GM.config.get('discord_role_id_gvg');
        var discordRoleIdSvs = await window.GM.config.get('discord_role_id_svs');

        // Notification configs
        var notifyArmsrace30 = await window.GM.config.get('notify_armsrace_reminder_30');
        var notifyArmsrace5 = await window.GM.config.get('notify_armsrace_reminder_5');
        var notifyArmsraceStart = await window.GM.config.get('notify_armsrace_start');
        var notifyArmsraceCreation = await window.GM.config.get('notify_armsrace_creation');

        var notifyDtr30 = await window.GM.config.get('notify_dtr_reminder_30');
        var notifyDtr5 = await window.GM.config.get('notify_dtr_reminder_5');
        var notifyDtrStart = await window.GM.config.get('notify_dtr_start');
        var notifyDtrCreation = await window.GM.config.get('notify_dtr_creation');

        var notifyShadowfront30 = await window.GM.config.get('notify_shadowfront_reminder_30');
        var notifyShadowfront5 = await window.GM.config.get('notify_shadowfront_reminder_5');
        var notifyShadowfrontStart = await window.GM.config.get('notify_shadowfront_start');
        var notifyShadowfrontCreation = await window.GM.config.get('notify_shadowfront_creation');

        var notifyCalamity10 = await window.GM.config.get('notify_calamity_10');
        var notifyGvgPvp = await window.GM.config.get('notify_gvg_pvp');
        
        var notifySvsGarrison = await window.GM.config.get('notify_svs_garrison');
        var notifySvsPvp = await window.GM.config.get('notify_svs_pvp');
        var notifySvsWonPrep = await window.GM.config.get('notify_svs_won_prep');

        document.getElementById('coeff-svs').value = coeffSvs;
        document.getElementById('coeff-gvg').value = coeffGvg;
        document.getElementById('coeff-shadowfront').value = coeffShadowfront;
        document.getElementById('coeff-dtr').value = coeffDtr;
        document.getElementById('coeff-armsrace').value = coeffArmsrace;

        // Set webhook inputs
        document.getElementById('webhook-armsrace').value = webhookArmsrace;
        document.getElementById('webhook-dtr').value = webhookDtr;
        document.getElementById('webhook-shadowfront').value = webhookShadowfront;
        document.getElementById('webhook-calamity').value = webhookCalamity;
        document.getElementById('webhook-gvg').value = webhookGvg;
        document.getElementById('webhook-svs').value = webhookSvs;
        document.getElementById('discord-role-id').value = discordRoleId || '';
        document.getElementById('discord-role-id-armsrace').value = discordRoleIdArmsrace || '';
        document.getElementById('discord-role-id-dtr').value = discordRoleIdDtr || '';
        document.getElementById('discord-role-id-shadowfront').value = discordRoleIdShadowfront || '';
        document.getElementById('discord-role-id-calamity').value = discordRoleIdCalamity || '';
        document.getElementById('discord-role-id-gvg').value = discordRoleIdGvg || '';
        document.getElementById('discord-role-id-svs').value = discordRoleIdSvs || '';

        var setCheckedState = function (id, value, defaultValue) {
            var el = document.getElementById(id);
            if (!el) return;
            if (value === null || value === undefined || value === '') {
                el.checked = defaultValue;
            } else {
                el.checked = (value === 'true' || value === '1');
            }
        };

        setCheckedState('notify-armsrace-creation', notifyArmsraceCreation, true);
        setCheckedState('notify-armsrace-30', notifyArmsrace30, true);
        setCheckedState('notify-armsrace-5', notifyArmsrace5, true);
        setCheckedState('notify-armsrace-start', notifyArmsraceStart, true);

        setCheckedState('notify-dtr-creation', notifyDtrCreation, true);
        setCheckedState('notify-dtr-30', notifyDtr30, true);
        setCheckedState('notify-dtr-5', notifyDtr5, true);
        setCheckedState('notify-dtr-start', notifyDtrStart, true);

        setCheckedState('notify-shadowfront-creation', notifyShadowfrontCreation, true);
        setCheckedState('notify-shadowfront-30', notifyShadowfront30, true);
        setCheckedState('notify-shadowfront-5', notifyShadowfront5, true);
        setCheckedState('notify-shadowfront-start', notifyShadowfrontStart, true);

        setCheckedState('notify-calamity-10', notifyCalamity10, true);
        setCheckedState('notify-gvg-pvp', notifyGvgPvp, true);

        setCheckedState('notify-svs-garrison', notifySvsGarrison, true);
        setCheckedState('notify-svs-pvp', notifySvsPvp, true);
        setCheckedState('notify-svs-won-prep', notifySvsWonPrep, false);
    }

    var guildSettingsForm = document.getElementById('guild-settings-form');
    if (guildSettingsForm) {
        guildSettingsForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            
            var btn = e.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            var span = btn.querySelector('span');
            var origText = span ? span.textContent : '';
            if (span) span.textContent = '...';

            try {
                var showCalamityGvgSvs = (await window.GM.config.get('gvg_svs_calamity_enabled')) !== 'false';
                await Promise.all([
                    window.GM.config.set('coeff_svs', document.getElementById('coeff-svs').value),
                    window.GM.config.set('coeff_gvg', document.getElementById('coeff-gvg').value),
                    window.GM.config.set('coeff_shadowfront', document.getElementById('coeff-shadowfront').value),
                    window.GM.config.set('coeff_dtr', document.getElementById('coeff-dtr').value),
                    window.GM.config.set('coeff_armsrace', document.getElementById('coeff-armsrace').value),

                    window.GM.config.set('webhook_armsrace', document.getElementById('webhook-armsrace').value.trim()),
                    window.GM.config.set('webhook_dtr', document.getElementById('webhook-dtr').value.trim()),
                    window.GM.config.set('webhook_shadowfront', document.getElementById('webhook-shadowfront').value.trim()),
                    window.GM.config.set('webhook_calamity', showCalamityGvgSvs ? document.getElementById('webhook-calamity').value.trim() : ''),
                    window.GM.config.set('webhook_gvg', showCalamityGvgSvs ? document.getElementById('webhook-gvg').value.trim() : ''),
                    window.GM.config.set('webhook_svs', showCalamityGvgSvs ? document.getElementById('webhook-svs').value.trim() : ''),
                    window.GM.config.set('discord_role_id', document.getElementById('discord-role-id').value.trim()),
                    window.GM.config.set('discord_role_id_armsrace', document.getElementById('discord-role-id-armsrace').value.trim()),
                    window.GM.config.set('discord_role_id_dtr', document.getElementById('discord-role-id-dtr').value.trim()),
                    window.GM.config.set('discord_role_id_shadowfront', document.getElementById('discord-role-id-shadowfront').value.trim()),
                    window.GM.config.set('discord_role_id_calamity', showCalamityGvgSvs ? document.getElementById('discord-role-id-calamity').value.trim() : ''),
                    window.GM.config.set('discord_role_id_gvg', showCalamityGvgSvs ? document.getElementById('discord-role-id-gvg').value.trim() : ''),
                    window.GM.config.set('discord_role_id_svs', showCalamityGvgSvs ? document.getElementById('discord-role-id-svs').value.trim() : ''),

                    // Notification Configs
                    window.GM.config.set('notify_armsrace_creation', document.getElementById('notify-armsrace-creation').checked ? 'true' : 'false'),
                    window.GM.config.set('notify_armsrace_reminder_30', document.getElementById('notify-armsrace-30').checked ? 'true' : 'false'),
                    window.GM.config.set('notify_armsrace_reminder_5', document.getElementById('notify-armsrace-5').checked ? 'true' : 'false'),
                    window.GM.config.set('notify_armsrace_start', document.getElementById('notify-armsrace-start').checked ? 'true' : 'false'),

                    window.GM.config.set('notify_dtr_creation', document.getElementById('notify-dtr-creation').checked ? 'true' : 'false'),
                    window.GM.config.set('notify_dtr_reminder_30', document.getElementById('notify-dtr-30').checked ? 'true' : 'false'),
                    window.GM.config.set('notify_dtr_reminder_5', document.getElementById('notify-dtr-5').checked ? 'true' : 'false'),
                    window.GM.config.set('notify_dtr_start', document.getElementById('notify-dtr-start').checked ? 'true' : 'false'),

                    window.GM.config.set('notify_shadowfront_creation', document.getElementById('notify-shadowfront-creation').checked ? 'true' : 'false'),
                    window.GM.config.set('notify_shadowfront_reminder_30', document.getElementById('notify-shadowfront-30').checked ? 'true' : 'false'),
                    window.GM.config.set('notify_shadowfront_reminder_5', document.getElementById('notify-shadowfront-5').checked ? 'true' : 'false'),
                    window.GM.config.set('notify_shadowfront_start', document.getElementById('notify-shadowfront-start').checked ? 'true' : 'false'),

                    window.GM.config.set('notify_calamity_10', (showCalamityGvgSvs && document.getElementById('notify-calamity-10').checked) ? 'true' : 'false'),
                    window.GM.config.set('notify_gvg_pvp', (showCalamityGvgSvs && document.getElementById('notify-gvg-pvp').checked) ? 'true' : 'false'),

                    window.GM.config.set('notify_svs_garrison', (showCalamityGvgSvs && document.getElementById('notify-svs-garrison').checked) ? 'true' : 'false'),
                    window.GM.config.set('notify_svs_pvp', (showCalamityGvgSvs && document.getElementById('notify-svs-pvp').checked) ? 'true' : 'false'),
                    window.GM.config.set('notify_svs_won_prep', (showCalamityGvgSvs && document.getElementById('notify-svs-won-prep').checked) ? 'true' : 'false')
                ]);
                
                showToast(t('toast_config_updated'), 'success');
            } catch (err) {
                showToast(t('toast_err_generic') + ' ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                if (span) span.textContent = origText;
            }
        });
    }

    async function renderPendingRegistrations(activeG) {
        var container = document.getElementById('pending-account-list');
        var countEl = document.getElementById('pending-account-count');
        if (!container) return;

        activeG = activeG || (window.GM ? window.GM.getActiveGuild() : 'ALPHA');

        var pending = [];
        if (accounts && accounts.length > 0) {
            pending = accounts.filter(function (acc) {
                return acc.status === 'pending' && acc.role === 'member' &&
                       (acc.guild || 'ALPHA') === activeG;
            });
        } else {
            var db = (window.GM && window.GM.db) ? window.GM.db : null;
            if (db) {
                try {
                    var res = await db.from('accounts')
                        .select('id, uid, status, role, guild, created_at')
                        .eq('status', 'pending')
                        .eq('role', 'member')
                        .eq('guild', activeG);
                    pending = res.data || [];
                } catch (e) {
                    console.warn('[GM] Error loading pending accounts:', e);
                }
            }
        }

        if (countEl) countEl.textContent = pending.length;

        if (pending.length === 0) {
            container.innerHTML = '<div class="gm-empty" style="padding:1.5rem;"><i class="ph-duotone ph-hourglass gm-icon"></i><div class="gm-empty-title">No pending registrations</div></div>';
            return;
        }

        var html = '<div class="gm-cred-grid">';
        pending.forEach(function (acc) {
            var dateStr = acc.created_at ? new Date(acc.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-';
            html +=
                '<div class="gm-cred-card" data-acc-id="' + esc(acc.id) + '">' +
                    '<div class="gm-row" style="justify-content:space-between; margin-bottom: 0.25rem;">' +
                        '<div class="gm-cred-name" style="font-weight:700; color:var(--fg);">' + esc(acc.id) + '</div>' +
                        '<span class="gm-chip gm-chip-warning">Pending</span>' +
                    '</div>' +
                    '<div class="gm-row gm-dim" style="font-size:.75rem; gap: 0.75rem;">' +
                        '<span><i class="ph ph-identification-badge"></i> UID ' + esc(acc.uid || '?') + '</span>' +
                        '<span><i class="ph ph-calendar-blank"></i> ' + dateStr + '</span>' +
                    '</div>' +
                    '<div class="gm-row" style="gap: 0.5rem; margin-top: 0.6rem;">' +
                        '<button class="gm-btn gm-btn-sm gm-btn-success gm-pending-approve" data-id="' + esc(acc.id) + '">' +
                            '<i class="ph ph-check"></i><span>Approve</span>' +
                        '</button>' +
                        '<button class="gm-btn gm-btn-sm gm-btn-danger-ghost gm-pending-reject" data-id="' + esc(acc.id) + '">' +
                            '<i class="ph ph-x"></i><span>Reject</span>' +
                        '</button>' +
                    '</div>' +
                '</div>';
        });
        html += '</div>';
        container.innerHTML = html;

        container.querySelectorAll('.gm-pending-approve').forEach(function (btn) {
            btn.addEventListener('click', function () { resolveRegistration(btn.getAttribute('data-id'), 'approve'); });
        });
        container.querySelectorAll('.gm-pending-reject').forEach(function (btn) {
            btn.addEventListener('click', function () { resolveRegistration(btn.getAttribute('data-id'), 'reject'); });
        });
    }

    if (window.GM) {
        window.GM.renderPendingRegistrations = renderPendingRegistrations;
    }

    async function resolveRegistration(id, action) {
        try {
            var res = await window.GM.adminAccounts(action === 'approve' ? 'approve-registration' : 'reject-registration', { id: id });
            if (!res.ok) throw new Error(res.error || (action + '_failed'));
            accounts = accounts.filter(function (a) { return a.id !== id; });
            renderAccounts();
            if (window.GM_OVERVIEW && window.GM_OVERVIEW.load) {
                window.GM_OVERVIEW.load();
            } else {
                renderPendingRegistrations();
            }
            showToast(action === 'approve' ? 'Player account approved.' : 'Player registration rejected.', 'success');
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    // ─── Guild Join Code (player self-registration) ───────────────────────────
    // The plain code is kept in localStorage (per guild) so it stays visible
    // when the tab is revisited or the page reloads. It is a shared invite
    // code meant to be broadcast to players (like a Discord invite), not a
    // secret credential; the DB only ever stores its SHA-256 hash.
    function joinCodeStorageKey() {
        var guild = window.currentGuild || window.GM.getActiveGuild() || 'ALPHA';
        return 'gm_join_code_plain_' + guild;
    }

    function wireJoinCode() {
        var copyBtn = document.getElementById('join-code-copy-btn');
        var resultBox = document.getElementById('join-code-result');
        var resultVal = document.getElementById('join-code-value');
        var infoEl = document.getElementById('join-code-info');
        if (!resultVal) return;

        var currentCode = '';

        function showCode(code) {
            if (!resultVal) return;
            currentCode = code || '';
            resultVal.textContent = code || 'No code yet';
            if (code) {
                resultBox.classList.remove('gm-join-code-empty');
                if (copyBtn) copyBtn.classList.remove('hidden');
            } else {
                resultBox.classList.add('gm-join-code-empty');
                if (copyBtn) copyBtn.classList.add('hidden');
            }
        }

        function setInfo(text) {
            if (infoEl) infoEl.textContent = text;
        }

        async function loadJoinCode() {
            var guild = window.currentGuild || window.GM.getActiveGuild() || 'ALPHA';
            try {
                var res = await window.GM.adminAccounts('get-join-code', { guild: guild });
                if (!res.ok) throw new Error(res.error || 'get_code_failed');
                if (res.code) {
                    // Code already persisted: just display it, never regenerate.
                    showCode(res.code);
                    setInfo('This is your guild\'s permanent join code. Share it with your players.');
                } else {
                    // No persistent code yet: generate ONE now and save it.
                    var generatedCode = window.GM.generateJoinCode('FGF');
                    var setRes = await window.GM.adminAccounts('set-join-code', {
                        code: generatedCode,
                        guild: guild
                    });
                    if (!setRes.ok) throw new Error(setRes.error || 'set_code_failed');
                    try { localStorage.setItem(joinCodeStorageKey(), generatedCode); } catch (_) {}
                    showCode(generatedCode);
                    setInfo('This is your guild\'s permanent join code. Share it with your players.');
                    showToast('Join code created.', 'success');
                }
            } catch (err) {
                // Fallback to the legacy localStorage plain code if available.
                var storedCode = '';
                try { storedCode = localStorage.getItem(joinCodeStorageKey()) || ''; } catch (_) {}
                if (storedCode) {
                    showCode(storedCode);
                    setInfo('This is your guild\'s permanent join code. Share it with your players.');
                } else {
                    showCode('');
                    setInfo('Unable to load the join code.');
                }
            }
        }

        loadJoinCode();

        if (copyBtn) copyBtn.addEventListener('click', function () {
            var code = currentCode || (resultVal ? resultVal.textContent : '') || '';
            if (!code || code === 'No code yet') return;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(code).then(function () {
                    showToast('Join code copied.', 'success');
                }).catch(function () {});
            }
        });
    }

    function renderAccounts() {
        var activeG = window.currentGuild || 'ALPHA';
        var isSuperAdminUser = window.GM.roleFromStorage() === 'super_admin';

        // Target 0: Pending player registrations (role member, status pending)
        renderPendingRegistrations(activeG);

        // Active accounts for current active guild (status !== 'pending')
        var activeAccounts = accounts.filter(function (acc) {
            if (acc.status === 'pending') return false;
            var accGuild = acc.guild || 'ALPHA';
            var isR5 = (acc.role === 'super_admin');
            if (isR5) return true;
            return accGuild === activeG;
        });

        // 1. Admin Accounts (super_admin & guild_admin)
        var adminAccountsList = activeAccounts.filter(function (acc) {
            return acc.role !== 'member';
        });

        // 2. Member Accounts (role === 'member')
        var memberAccountsList = activeAccounts.filter(function (acc) {
            return acc.role === 'member';
        });

        // Target 1: Admin Section (#account-list)
        var containerAdmin = document.getElementById('account-list');
        var countAdmin = document.getElementById('account-count');
        if (containerAdmin) {
            renderAccountCardsToContainer(containerAdmin, countAdmin, adminAccountsList, isSuperAdminUser);
        }

        // Target 1b: Member Section (#member-account-list)
        var containerMember = document.getElementById('member-account-list');
        var countMember = document.getElementById('member-account-count');
        if (containerMember) {
            renderAccountCardsToContainer(containerMember, countMember, memberAccountsList, isSuperAdminUser);
        }

        // Target 2: Super Admin Section (#superadmin-account-list) - accordion grouping by server
        var containerR5 = document.getElementById('superadmin-account-list');
        var countR5 = document.getElementById('superadmin-account-count');
        if (containerR5) {
            var listR5 = accounts.filter(function (acc) {
                return acc.role === 'guild_admin';
            });
            listR5.sort(function (a, b) {
                var gA = a.guild || '';
                var gB = b.guild || '';
                if (gA !== gB) return gA.localeCompare(gB);
                return a.id.localeCompare(b.id);
            });
            renderSuperAdminGroupedAccounts(containerR5, countR5, listR5, isSuperAdminUser);
        }
    }

    function getServerNumberForGuild(guildId) {
        if (!guildId) return '';
        if (window.guildsData && window.guildsData[guildId] && window.guildsData[guildId].server_number) {
            return String(window.guildsData[guildId].server_number);
        }
        var ls = localStorage.getItem('gm_server_number_' + guildId);
        if (ls) return String(ls);
        return '';
    }

    function renderSuperAdminGroupedAccounts(container, countEl, listToRender, isSuperAdminUser) {
        if (!container) return;
        if (countEl) countEl.textContent = listToRender.length;

        if (listToRender.length === 0) {
            container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_accounts') + '</div></div>';
            return;
        }

        // Group accounts by server
        var groupedByServer = {};
        listToRender.forEach(function (acc) {
            var g = acc.guild || 'ALPHA';
            var sNum = getServerNumberForGuild(g);
            var sKey = sNum ? ('Server #' + sNum) : 'Unassigned Server';
            if (!groupedByServer[sKey]) {
                groupedByServer[sKey] = { serverKey: sKey, sNum: sNum, accounts: [], guildsSet: {} };
            }
            groupedByServer[sKey].accounts.push(acc);
            groupedByServer[sKey].guildsSet[g] = true;
        });

        // Sort server keys (numerically by server # first)
        var serverKeys = Object.keys(groupedByServer).sort(function (a, b) {
            var numA = parseInt(a.replace(/\D/g, ''), 10) || 999999;
            var numB = parseInt(b.replace(/\D/g, ''), 10) || 999999;
            if (numA !== numB) return numA - numB;
            return a.localeCompare(b);
        });

        var html = '';
        serverKeys.forEach(function (sKey, index) {
            var group = groupedByServer[sKey];
            var guildsList = Object.keys(group.guildsSet).sort().join(', ');
            var accCount = group.accounts.length;
            var isFirst = (index === 0);

            html +=
                '<div class="gm-card glass-card" style="margin-bottom:1rem; padding:0; overflow:hidden;">' +
                    '<div class="gm-accordion-header" style="padding:0.9rem 1.2rem; display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-soft); transition:background 0.2s ease;">' +
                        '<div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap;">' +
                            '<span style="background:rgba(59, 130, 246, 0.15); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.3); border-radius:6px; padding:3px 10px; font-weight:800; font-size:0.85rem; font-family:var(--font-display);">' +
                                '<i class="ph ph-hard-drives" style="margin-right:4px;"></i>' + esc(sKey) +
                            '</span>' +
                            '<span style="font-weight:700; color:var(--fg); font-size:0.9rem;">' + esc(guildsList) + '</span>' +
                            '<span class="gm-badge" style="background:var(--accent-soft); color:var(--accent); font-weight:700; font-size:0.75rem;">' + accCount + ' admin' + (accCount > 1 ? 's' : '') + '</span>' +
                        '</div>' +
                        '<i class="ph ph-caret-down gm-accordion-arrow" style="font-size:1.2rem; color:var(--fg-dim); transition:transform 0.25s ease;' + (isFirst ? ' transform:rotate(180deg);' : '') + '"></i>' +
                    '</div>' +
                    '<div class="gm-accordion-body" style="padding:1rem 1.25rem;' + (isFirst ? ' display:block;' : ' display:none;') + '">' +
                        '<div id="acc-grid-' + index + '" class="gm-account-grid"></div>' +
                    '</div>' +
                '</div>';
        });

        container.innerHTML = html;

        // Render card contents into each accordion body grid
        serverKeys.forEach(function (sKey, index) {
            var gridEl = document.getElementById('acc-grid-' + index);
            if (gridEl) {
                renderAccountCardsToContainer(gridEl, null, groupedByServer[sKey].accounts, isSuperAdminUser);
            }
        });

        // Wire accordion header click toggles
        container.querySelectorAll('.gm-accordion-header').forEach(function (headerEl) {
            headerEl.addEventListener('click', function () {
                var bodyEl = headerEl.nextElementSibling;
                var arrowEl = headerEl.querySelector('.gm-accordion-arrow');
                if (!bodyEl) return;
                var isHidden = (bodyEl.style.display === 'none');
                if (isHidden) {
                    bodyEl.style.display = 'block';
                    if (arrowEl) arrowEl.style.transform = 'rotate(180deg)';
                } else {
                    bodyEl.style.display = 'none';
                    if (arrowEl) arrowEl.style.transform = 'rotate(0deg)';
                }
            });
        });
    }

    function renderAccountCardsToContainer(container, countEl, listToRender, isSuperAdminUser) {
        if (!container) return;
        if (countEl) countEl.textContent = listToRender.length;

        if (listToRender.length === 0) {
            container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_accounts') + '</div></div>';
            return;
        }

        var html = '<div class="gm-cred-grid">';
        listToRender.forEach(function (acc) {
            var role = acc.role || 'guild_admin';
            var roleLabel = 'Admin';
            var chipCls = 'gm-chip-info';

            if (role === 'super_admin') {
                roleLabel = 'Super Admin';
                chipCls = 'gm-chip-accent';
            } else if (role === 'member') {
                roleLabel = 'Member';
                chipCls = 'gm-chip-lilac';
            }
            var dateStr = acc.created_at ? new Date(acc.created_at).toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' }) : '-';
            var guildLabel = acc.guild ? 'Guild: ' + acc.guild : 'All Guilds';
            var guildCls = acc.guild ? 'gm-chip-warning' : 'gm-chip-success';

            var isSuperAdminAccount = (role === 'super_admin');
            
            // Password management permission:
            // Super Admin account password CANNOT be viewed/copied by regular R4 admins!
            var canManagePass = isSuperAdminUser || !isSuperAdminAccount;
            
            // Delete permission:
            // Super Admin account CANNOT be deleted by regular R4 admins!
            var canDelete = isSuperAdminUser || !isSuperAdminAccount;

            var passHtml = '';
            if (canManagePass) {
                passHtml = '<div class="gm-cred-pass gm-masked" data-acc-id="' + esc(acc.id) + '">' +
                               '<span class="gm-pwd-text">••••••••••••</span>' +
                               '<button class="gm-mini-btn gm-cred-reset" title="Renew Password"><i class="ph ph-arrows-clockwise"></i></button>' +
                               '<button class="gm-mini-btn gm-cred-copy hidden" title="Copy Password"><i class="ph ph-copy"></i></button>' +
                           '</div>';
            } else {
                passHtml = '<div class="gm-cred-pass gm-masked" style="opacity: 0.6; cursor: not-allowed;" title="Protected Super Admin Account">' +
                               '<span class="gm-pwd-text">••••••••••••</span>' +
                           '</div>';
            }

            var deleteHtml = '';
            if (canDelete) {
                deleteHtml = '<button class="gm-mini-btn gm-danger gm-cred-delete" data-id="' + esc(acc.id) + '" title="' + t('delete_title') + '" style="margin-left:auto;">' +
                                 '<i class="ph ph-trash"></i>' +
                             '</button>';
            }

            var guildSelectHtml = '';
            if (acc.role !== 'super_admin' && isSuperAdminUser) {
                var options = '<option value="ALL"' + (!acc.guild ? ' selected' : '') + '>All Guilds</option>';
                (window.guildsList || []).forEach(function (g) {
                    options += '<option value="' + esc(g) + '"' + (acc.guild === g ? ' selected' : '') + '>' + esc(g) + '</option>';
                });
                guildSelectHtml = '<select class="gm-select gm-select-sm gm-account-guild-select" data-id="' + esc(acc.id) + '" style="font-size: 0.75rem; padding: 0.15rem 0.4rem; height: auto; width: auto; min-width: 90px; border-radius: 4px; line-height: 1.2;">' +
                                      options +
                                  '</select>';
            } else {
                guildSelectHtml = '<span class="gm-chip ' + guildCls + '" style="font-size: 0.7rem;">' + esc(guildLabel) + '</span>';
            }

            html +=
                '<div class="gm-cred-card" data-acc-id="' + esc(acc.id) + '">' +
                    '<div class="gm-row" style="justify-content:space-between; margin-bottom: 0.25rem;">' +
                        '<div class="gm-cred-name">' + esc(acc.id) + '</div>' +
                        '<div class="gm-row" style="gap: 0.25rem; align-items: center;">' +
                            '<span class="gm-chip ' + chipCls + '">' + esc(roleLabel) + '</span>' +
                            guildSelectHtml +
                        '</div>' +
                    '</div>' +
                    passHtml +
                    '<div class="gm-row gm-dim" style="font-size:.75rem;">' +
                        '<i class="ph ph-calendar-blank"></i>' +
                        '<span>' + t('cred_created') + ' ' + dateStr + '</span>' +
                        deleteHtml +
                    '</div>' +
                '</div>';
        });
        html += '</div>';
        container.innerHTML = html;

        wireAccountCardListeners(container);
    }

    function wireAccountCardListeners(container) {
        if (!container) return;

        // Renew password listener for account cards
        container.querySelectorAll('.gm-cred-reset').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                var wrap = btn.closest('.gm-cred-pass');
                var accId = wrap.getAttribute('data-acc-id');
                var pwdSpan = wrap.querySelector('.gm-pwd-text');
                var copyBtn = wrap.querySelector('.gm-cred-copy');
                var icon = btn.querySelector('i');

                btn.disabled = true;
                if (icon) icon.className = 'ph ph-circle-notch ph-spin';

                try {
                    var newPass = generatePassword(12);
                    var res = await window.GM.adminAccounts('reset-password', { id: accId, password: newPass });
                    if (!res.ok) throw new Error(res.error || 'reset_failed');
                    var pass = res.password || newPass;
                    pendingPasswords[accId] = pass;
                    wrap.setAttribute('data-acc-pass-temp', pass);
                    wrap.classList.remove('gm-masked');
                    pwdSpan.textContent = pass;
                    if (copyBtn) copyBtn.classList.remove('hidden');
                    if (navigator.clipboard) {
                        navigator.clipboard.writeText(pass).catch(function () {});
                    }
                    showToast('Password renewed: ' + pass + ' (copied to clipboard)', 'success');
                } catch (err) {
                    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                } finally {
                    btn.disabled = false;
                    if (icon) icon.className = 'ph ph-arrows-clockwise';
                }
            });
        });

        container.querySelectorAll('.gm-cred-copy').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var wrap = btn.closest('.gm-cred-pass');
                var accId = wrap.getAttribute('data-acc-id');
                var pass = pendingPasswords[accId] || wrap.getAttribute('data-acc-pass-temp');
                if (!pass) return;
                if (navigator.clipboard) {
                    navigator.clipboard.writeText(pass).then(function () {
                        var icon = btn.querySelector('i');
                        if (icon) icon.className = 'ph ph-check';
                        showToast('Password copied to clipboard.', 'success');
                        setTimeout(function () { if (icon) icon.className = 'ph ph-copy'; }, 2000);
                    });
                }
            });
        });

        container.querySelectorAll('.gm-cred-delete').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-id');
                showConfirm(
                    t('confirm_delete_account_title'),
                    t('confirm_delete_account_body') + ' <strong>' + esc(id) + '</strong>' + t('confirm_delete_account_body2'),
                    function () { deleteAccount(id); }
                );
            });
        });

        container.querySelectorAll('.gm-account-guild-select').forEach(function (sel) {
            sel.addEventListener('change', async function () {
                var id = sel.getAttribute('data-id');
                var newGuild = sel.value;
                sel.disabled = true;
                try {
                    var res = await window.GM.adminAccounts('update-guild', { id: id, guild: newGuild });
                    if (!res.ok) throw new Error(res.error || 'update_failed');
                    showToast('Access for ' + id + ' updated successfully!', 'success');
                    
                    var acc = accounts.find(function (a) { return a.id === id; });
                    if (acc) {
                        acc.guild = (newGuild === 'ALL' ? null : newGuild);
                    }
                    renderAccounts();
                } catch (err) {
                    showToast('Error updating: ' + err.message, 'error');
                    fetchAccounts();
                } finally {
                    sel.disabled = false;
                }
            });
        });
    }

    async function renderGuildsSubscriptionList() {
        var container = document.getElementById('guilds-list-container');
        if (!container) return;

        if (!supabase) return;
        try {
            var res = await supabase
                .from('guilds')
                .select('id, subscription_type, subscription_end, server_number')
                .order('id');
            if (res.error) throw res.error;
            var guildsListRaw = res.data;
            if (!guildsListRaw || guildsListRaw.length === 0) {
                container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">No guild found</div></div>';
                return;
            }

            // Group guilds by Server
            var groupedByServer = {};
            guildsListRaw.forEach(function (g) {
                var guildId = g.id;
                var serverNum = g.server_number || (window.guildsData && window.guildsData[guildId] ? window.guildsData[guildId].server_number : '') || localStorage.getItem('gm_server_number_' + guildId) || '';
                var sKey = serverNum ? ('Server #' + serverNum) : 'Unassigned Server';
                if (!groupedByServer[sKey]) {
                    groupedByServer[sKey] = { serverKey: sKey, sNum: serverNum, guilds: [] };
                }
                groupedByServer[sKey].guilds.push(g);
            });

            // Sort server keys (numerically by server # first)
            var serverKeys = Object.keys(groupedByServer).sort(function (a, b) {
                var numA = parseInt(a.replace(/\D/g, ''), 10) || 999999;
                var numB = parseInt(b.replace(/\D/g, ''), 10) || 999999;
                if (numA !== numB) return numA - numB;
                return a.localeCompare(b);
            });

            var html = '';
            serverKeys.forEach(function (sKey, index) {
                var group = groupedByServer[sKey];
                var guildsListStr = group.guilds.map(function(item){ return item.id; }).sort().join(', ');
                var gCount = group.guilds.length;
                var isFirst = (index === 0);

                html +=
                    '<div class="gm-card glass-card" style="margin-bottom:1rem; padding:0; overflow:hidden;">' +
                        '<div class="gm-accordion-header" style="padding:0.9rem 1.2rem; display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-soft); transition:background 0.2s ease;">' +
                            '<div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap;">' +
                                '<span style="background:rgba(59, 130, 246, 0.15); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.3); border-radius:6px; padding:3px 10px; font-weight:800; font-size:0.85rem; font-family:var(--font-display);">' +
                                    '<i class="ph ph-hard-drives" style="margin-right:4px;"></i>' + esc(sKey) +
                                '</span>' +
                                '<span style="font-weight:700; color:var(--fg); font-size:0.9rem;">' + esc(guildsListStr) + '</span>' +
                                '<span class="gm-badge" style="background:var(--accent-soft); color:var(--accent); font-weight:700; font-size:0.75rem;">' + gCount + ' guild' + (gCount > 1 ? 's' : '') + '</span>' +
                            '</div>' +
                            '<i class="ph ph-caret-down gm-accordion-arrow" style="font-size:1.2rem; color:var(--fg-dim); transition:transform 0.25s ease;' + (isFirst ? ' transform:rotate(180deg);' : '') + '"></i>' +
                        '</div>' +
                        '<div class="gm-accordion-body" style="padding:1rem 1.25rem;' + (isFirst ? ' display:block;' : ' display:none;') + '">' +
                            '<div class="gm-cred-grid">';

                group.guilds.forEach(function (g) {
                    var guildId = g.id;
                    var type = g.subscription_type || 'Unlimited';
                    var end = g.subscription_end;
                    var serverNum = g.server_number || (window.guildsData && window.guildsData[guildId] ? window.guildsData[guildId].server_number : '') || localStorage.getItem('gm_server_number_' + guildId) || '';
                    var dateVal = end ? end.split('T')[0] : '';

                    // Calculate countdown html
                    var countdownHtml = '';
                    if (type === 'Unlimited') {
                        countdownHtml = '<span class="gm-chip gm-chip-success" style="font-size: 0.75rem; font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;"><i class="ph ph-infinity"></i> Unlimited</span>';
                    } else if (type === 'Lifetime') {
                        countdownHtml = '<span class="gm-chip gm-chip-success" style="font-size: 0.75rem; font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;"><i class="ph ph-infinity"></i> Lifetime</span>';
                    } else {
                        if (end) {
                            var endMs = new Date(end).getTime();
                            var nowMs = Date.now();
                            var diff = endMs - nowMs;
                            if (diff <= 0) {
                                countdownHtml = '<span class="gm-chip gm-chip-danger" style="font-size: 0.75rem; font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;"><i class="ph ph-lock-keyhole"></i> Expired</span>';
                            } else {
                                var secs = Math.floor(diff / 1000);
                                var mins = Math.floor(secs / 60);
                                var hours = Math.floor(mins / 60);
                                var days = Math.floor(hours / 24);

                                var timeStr = '';
                                if (days > 0) {
                                    timeStr = days + 'd ' + (hours % 24) + 'h';
                                } else if (hours > 0) {
                                    timeStr = hours + 'h ' + (mins % 60) + 'm';
                                } else {
                                    timeStr = mins + 'm';
                                }
                                countdownHtml = '<span class="gm-chip gm-chip-warning" style="font-size: 0.75rem; font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;"><i class="ph ph-clock"></i> ' + timeStr + ' remaining</span>';
                            }
                        } else {
                            countdownHtml = '<span class="gm-chip gm-chip-danger" style="font-size: 0.75rem; font-weight: 700;">No date (Expired)</span>';
                        }
                    }

                    var serverTag = serverNum ? ' <span style="font-size:0.8rem; font-weight:500; color:var(--fg-dim);">(Server #' + esc(serverNum) + ')</span>' : '';

                    html +=
                        '<div class="gm-cred-card" data-guild-id="' + esc(guildId) + '">' +
                            '<div class="gm-row" style="justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">' +
                                '<div class="gm-cred-name" style="font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem; margin-bottom:0; font-weight:600;">' +
                                    '<i class="ph ph-shield"></i> ' + esc(guildId) + serverTag +
                                '</div>' +
                                '<div class="countdown-badge-wrapper">' + countdownHtml + '</div>' +
                            '</div>' +
                            '<div class="gm-row" style="gap: 0.5rem; align-items: center; flex-wrap: wrap;">' +
                                '<div class="gm-col" style="flex: 1; gap: 0.25rem; min-width:100px;">' +
                                    '<label class="gm-dim" style="font-size: 0.75rem; margin-bottom:0;">Server #</label>' +
                                    '<input type="text" maxlength="4" pattern="\\d{4}" class="gm-input gm-input-sm guild-server-number" data-guild="' + esc(guildId) + '" value="' + esc(serverNum) + '" style="padding: 0.25rem 0.5rem; font-size:0.8rem; height: auto;" placeholder="e.g. 1089">' +
                                '</div>' +
                                '<div class="gm-col" style="flex: 1.2; gap: 0.25rem; min-width:110px;">' +
                                    '<label class="gm-dim" style="font-size: 0.75rem; margin-bottom:0;">Type</label>' +
                                    '<select class="gm-select gm-select-sm guild-sub-type" data-guild="' + esc(guildId) + '" style="padding: 0.25rem 0.5rem; font-size:0.8rem; height: auto;">' +
                                        '<option value="Unlimited"' + (type === 'Unlimited' ? ' selected' : '') + '>Unlimited</option>' +
                                        '<option value="Premium"' + (type === 'Premium' ? ' selected' : '') + '>Premium</option>' +
                                        '<option value="Lifetime"' + (type === 'Lifetime' ? ' selected' : '') + '>Lifetime</option>' +
                                    '</select>' +
                                '</div>' +
                                '<div class="gm-col guild-sub-end-wrapper" style="flex: 1.2; gap: 0.25rem; min-width:110px; ' + (type !== 'Premium' ? 'display: none;' : '') + '">' +
                                    '<label class="gm-dim" style="font-size: 0.75rem; margin-bottom:0;">End Date</label>' +
                                    '<input type="date" class="gm-input gm-input-sm guild-sub-end" data-guild="' + esc(guildId) + '" value="' + dateVal + '" style="padding: 0.25rem 0.5rem; font-size:0.8rem; height: auto;">' +
                                '</div>' +
                                '<button class="gm-btn gm-btn-primary save-guild-sub-btn" data-guild="' + esc(guildId) + '" style="margin-top: 1.15rem; padding: 0.35rem 0.65rem; font-size:0.8rem; display:flex; align-items:center; gap:0.25rem; height: auto; line-height: 1.2;">' +
                                    '<i class="ph ph-floppy-disk"></i> Save' +
                                '</button>' +
                                '<button class="gm-btn gm-btn-danger-ghost delete-guild-btn" data-guild="' + esc(guildId) + '" style="margin-top: 1.15rem; padding: 0.35rem 0.65rem; font-size:0.8rem; display:flex; align-items:center; gap:0.25rem; height: auto; line-height: 1.2;">' +
                                    '<i class="ph ph-trash"></i> Delete' +
                                '</button>' +
                            '</div>' +
                        '</div>';
                });

                html += '</div></div></div>';
            });

            container.innerHTML = html;

            // Wire accordion header click toggles
            container.querySelectorAll('.gm-accordion-header').forEach(function (headerEl) {
                headerEl.addEventListener('click', function () {
                    var bodyEl = headerEl.nextElementSibling;
                    var arrowEl = headerEl.querySelector('.gm-accordion-arrow');
                    if (!bodyEl) return;
                    var isHidden = (bodyEl.style.display === 'none');
                    if (isHidden) {
                        bodyEl.style.display = 'block';
                        if (arrowEl) arrowEl.style.transform = 'rotate(180deg)';
                    } else {
                        bodyEl.style.display = 'none';
                        if (arrowEl) arrowEl.style.transform = 'rotate(0deg)';
                    }
                });
            });

            // Wire change listener to type dropdown to show/hide end date
            container.querySelectorAll('.guild-sub-type').forEach(function (select) {
                select.addEventListener('change', function () {
                    var guildId = select.getAttribute('data-guild');
                    var wrapper = container.querySelector('.gm-cred-card[data-guild-id="' + guildId + '"] .guild-sub-end-wrapper');
                    if (wrapper) {
                        wrapper.style.display = select.value === 'Premium' ? '' : 'none';
                    }
                });
            });

            // Wire save button listeners
            container.querySelectorAll('.save-guild-sub-btn').forEach(function (btn) {
                btn.addEventListener('click', async function () {
                    var guildId = btn.getAttribute('data-guild');
                    var card = container.querySelector('.gm-cred-card[data-guild-id="' + guildId + '"]');
                    var select = card.querySelector('.guild-sub-type');
                    var input = card.querySelector('.guild-sub-end');
                    var serverNumInput = card.querySelector('.guild-server-number');

                    var type = select.value;
                    var endVal = null;
                    if (type === 'Premium') {
                        if (!input.value) {
                            showToast('Please specify an end date for Premium subscription.', 'error');
                            return;
                        }
                        endVal = new Date(input.value + 'T23:59:59Z').toISOString();
                    }

                    var serverNum = serverNumInput ? serverNumInput.value.trim() : '';
                    if (serverNum && !/^\d{4}$/.test(serverNum)) {
                        showToast('Server number must be exactly 4 digits (e.g. 1089).', 'error');
                        return;
                    }

                    btn.disabled = true;
                    var origText = btn.innerHTML;
                    btn.innerHTML = '<i class="ph ph-circle-notch spinner"></i>...';

                    // Immediately persist in localStorage and memory cache
                    localStorage.setItem('gm_server_number_' + guildId, serverNum);
                    if (window.guildsData && window.guildsData[guildId]) {
                        window.guildsData[guildId].server_number = serverNum;
                        window.guildsData[guildId].type = type;
                        window.guildsData[guildId].end = endVal;
                    }

                    try {
                        var updatePayload = {
                            subscription_type: type,
                            subscription_end: endVal,
                            server_number: serverNum || null
                        };
                        var res = await supabase.from('guilds').update(updatePayload).eq('id', guildId).select();

                        if (res.error) {
                            throw new Error(res.error.message || JSON.stringify(res.error));
                        }

                        showToast('Guild ' + guildId + (serverNum ? ' (Server #' + serverNum + ')' : '') + ' updated successfully!', 'success');
                        await fetchGuilds();
                        renderGuildsSubscriptionList();
                    } catch (err) {
                        showToast('Error during update: ' + err.message, 'error');
                    } finally {
                        btn.disabled = false;
                        btn.innerHTML = origText;
                    }
                });
            });

            // Wire delete button listeners
            container.querySelectorAll('.delete-guild-btn').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var guildId = btn.getAttribute('data-guild');
                    window.showConfirm(
                        t('confirm_delete_guild_title'),
                        t('confirm_delete_guild_body') + ' <strong>' + esc(guildId) + '</strong>' + t('confirm_delete_guild_body2'),
                        async function () {
                            btn.disabled = true;
                            var origText = btn.innerHTML;
                            btn.innerHTML = '<i class="ph ph-circle-notch spinner"></i>...';

                            try {
                                var res = await supabase.rpc('gm_delete_guild', { p_guild_id: guildId });
                                if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
                                var row = (Array.isArray(res.data) ? res.data[0] : res.data) || {};
                                if (!row.ok) throw new Error(row.error || 'Failed to delete guild');

                                // Clean memory caches / localStorage
                                localStorage.removeItem('gm_server_number_' + guildId);
                                if (window.guildsData) delete window.guildsData[guildId];
                                if (window.guildsList) {
                                    var idx = window.guildsList.indexOf(guildId);
                                    if (idx !== -1) window.guildsList.splice(idx, 1);
                                }

                                showToast('Guild ' + guildId + ' deleted successfully', 'success');
                                await fetchGuilds();
                                renderGuildsSubscriptionList();
                                if (window.populateGuildSelects) window.populateGuildSelects();
                            } catch (err) {
                                showToast('Error deleting guild: ' + err.message, 'error');
                                btn.disabled = false;
                                btn.innerHTML = origText;
                            }
                        }
                    );
                });
            });

        } catch (err) {
            container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-warning-octagon gm-icon" style="color:var(--danger);"></i><div class="gm-empty-title">Error: ' + esc(err.message) + '</div></div>';
        }
    }

    // ─── OCR Bulk Roster & Power Import ─────────────────────────────────────
    var ocrExtractedPlayers = [];
    var ocrInitialized = false;
    var BUILTIN_OCR_KEY = typeof atob === 'function' ? atob('QVEuQWI4Uk42SUI4YjhBNEdLWktocFVsVGVPSDlVWEdzQ0lybU5pWTRBeXZKMkhBNU5MMXc=') : '';

    function getOcrApiKey() {
        return BUILTIN_OCR_KEY;
    }

    function getOcrModel() {
        return 'gemini-flash-latest';
    }

    function parseGeminiJson(jsonText) {
        if (!jsonText) return null;
        var cleaned = String(jsonText).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        try {
            return JSON.parse(cleaned);
        } catch (e) {
            var firstObj = cleaned.indexOf('{');
            var lastObj = cleaned.lastIndexOf('}');
            var firstArr = cleaned.indexOf('[');
            var lastArr = cleaned.lastIndexOf(']');
            
            var start = -1;
            var end = -1;

            if (firstObj !== -1 && lastObj > firstObj) {
                start = firstObj;
                end = lastObj + 1;
            }
            if (firstArr !== -1 && lastArr > firstArr) {
                if (start === -1 || (firstArr !== -1 && firstArr < start)) {
                    start = firstArr;
                    end = lastArr + 1;
                }
            }

            if (start !== -1 && end > start) {
                var sub = cleaned.substring(start, end);
                try {
                    return JSON.parse(sub);
                } catch (e2) {
                    console.warn('Fallback OCR JSON substring parse failed:', e2);
                }
            }
            throw e;
        }
    }

    function openOcrModal() {
        initOcrGeminiModule();
        var modal = document.getElementById('ocr-modal-overlay');
        if (modal) {
            modal.style.display = 'flex';
            modal.classList.add('visible');
            resetOcrModalState();
        }
    }

    function closeOcrModal() {
        var modal = document.getElementById('ocr-modal-overlay');
        if (modal) {
            modal.classList.remove('visible');
            modal.style.display = 'none';
        }
    }

    function resetOcrModalState() {
        ocrExtractedPlayers = [];
        var dropzone = document.getElementById('ocr-dropzone');
        var loading = document.getElementById('ocr-loading');
        var resultsContainer = document.getElementById('ocr-results-container');
        var btnCommit = document.getElementById('ocr-commit-btn');
        var fileInput = document.getElementById('ocr-file-input');

        if (dropzone) dropzone.style.display = 'block';
        if (loading) loading.style.display = 'none';
        if (resultsContainer) resultsContainer.style.display = 'none';
        if (btnCommit) btnCommit.style.display = 'none';
        if (fileInput) fileInput.value = '';
    }

    window.openOcrModal = openOcrModal;
    window.closeOcrModal = closeOcrModal;
    window.GM = window.GM || {};
    window.GM.openOcrModal = openOcrModal;
    window.GM.closeOcrModal = closeOcrModal;
    window.GM.parseGeminiJson = parseGeminiJson;
    window.GM.getOcrModel = getOcrModel;

    // Document-level event delegation for OCR trigger buttons
    document.addEventListener('click', function (e) {
        var btn = e.target.closest('#btn-ocr-import, #btn-ocr-import-member, .btn-ocr-trigger');
        if (btn) {
            e.preventDefault();
            e.stopPropagation();
            openOcrModal();
        }
    });

    function initOcrGeminiModule() {
        var modal = document.getElementById('ocr-modal-overlay');
        var btnClose = document.getElementById('ocr-modal-close');
        var btnCancel = document.getElementById('ocr-modal-cancel');
        var dropzone = document.getElementById('ocr-dropzone');
        var fileInput = document.getElementById('ocr-file-input');
        var btnReset = document.getElementById('ocr-reset-btn');
        var btnSelectAll = document.getElementById('ocr-select-all-btn');
        var cbToggleAll = document.getElementById('ocr-toggle-all-cb');
        var btnCommit = document.getElementById('ocr-commit-btn');

        if (!modal) return;
        if (ocrInitialized) return;
        ocrInitialized = true;

        if (btnClose) btnClose.onclick = closeOcrModal;
        if (btnCancel) btnCancel.onclick = closeOcrModal;
        modal.onclick = function (e) {
            if (e.target === modal) closeOcrModal();
        };

        if (dropzone && fileInput) {
            dropzone.addEventListener('click', function () {
                fileInput.click();
            });

            dropzone.addEventListener('dragover', function (e) {
                e.preventDefault();
                dropzone.style.borderColor = 'var(--accent)';
                dropzone.style.background = 'rgba(99, 102, 241, 0.08)';
            });

            dropzone.addEventListener('dragleave', function (e) {
                e.preventDefault();
                dropzone.style.borderColor = 'rgba(99, 102, 241, 0.4)';
                dropzone.style.background = 'rgba(99, 102, 241, 0.03)';
            });

            dropzone.addEventListener('drop', function (e) {
                e.preventDefault();
                dropzone.style.borderColor = 'rgba(99, 102, 241, 0.4)';
                dropzone.style.background = 'rgba(99, 102, 241, 0.03)';
                var files = Array.from(e.dataTransfer.files);
                handleOcrFiles(files);
            });

            fileInput.addEventListener('change', function (e) {
                var files = Array.from(e.target.files);
                handleOcrFiles(files);
            });
        }

        if (btnReset) {
            btnReset.addEventListener('click', function () {
                resetOcrModalState();
            });
        }

        if (btnSelectAll && cbToggleAll) {
            btnSelectAll.addEventListener('click', function () {
                cbToggleAll.checked = !cbToggleAll.checked;
                toggleAllCheckboxes(cbToggleAll.checked);
            });
        }

        if (cbToggleAll) {
            cbToggleAll.addEventListener('change', function () {
                toggleAllCheckboxes(cbToggleAll.checked);
            });
        }

        if (btnCommit) {
            btnCommit.addEventListener('click', commitOcrUpdates);
        }
    }

    async function handleOcrFiles(files) {
        var dropzone = document.getElementById('ocr-dropzone');
        var loading = document.getElementById('ocr-loading');
        var resultsContainer = document.getElementById('ocr-results-container');
        var loadingH4 = loading ? loading.querySelector('h4') : null;
        var loadingP = loading ? loading.querySelector('p') : null;

        var imageFiles = files.filter(function (f) { return f.type.startsWith('image/'); });
        if (imageFiles.length === 0) {
            showToast('Please select a valid image file (PNG, JPG, WEBP).', 'error');
            return;
        }

        if (imageFiles.length > 25) {
            showToast('Processing maximum 25 screenshots per batch (200+ players).', 'info');
            imageFiles = imageFiles.slice(0, 25);
        }

        if (dropzone) dropzone.style.display = 'none';
        if (loading) loading.style.display = 'block';
        if (resultsContainer) resultsContainer.style.display = 'none';

        if (loadingH4) loadingH4.textContent = 'Analyzing screenshots with AI OCR...';

        var allPlayers = [];
        try {
            var imageItems = [];
            for (var i = 0; i < imageFiles.length; i++) {
                var file = imageFiles[i];
                var b64 = await fileToBase64(file);
                imageItems.push({ mimeType: file.type, base64Data: b64 });
            }

            var chunkSize = 4;
            var chunks = [];
            for (var c = 0; c < imageItems.length; c += chunkSize) {
                chunks.push(imageItems.slice(c, c + chunkSize));
            }

            for (var b = 0; b < chunks.length; b++) {
                var currentChunk = chunks[b];
                if (loadingP) {
                    loadingP.textContent = 'Processing screenshots batch ' + (b + 1) + ' of ' + chunks.length + ' (' + imageFiles.length + ' total images)...';
                }

                var extracted = await callGeminiOcrBatchApi(currentChunk, function (statusMsg) {
                    if (loadingP) loadingP.textContent = statusMsg;
                });

                allPlayers = allPlayers.concat(extracted);

                if (b < chunks.length - 1) {
                    await new Promise(function (r) { setTimeout(r, 1200); });
                }
            }

            var uniqueMap = {};
            allPlayers.forEach(function (p) {
                if (!p || !p.pseudo) return;
                var cleanPseudo = p.pseudo.trim();
                var key = cleanPseudo.toLowerCase();
                if (!uniqueMap[key] || (p.overall_power && p.overall_power > uniqueMap[key].overall_power)) {
                    uniqueMap[key] = {
                        pseudo: cleanPseudo,
                        overall_power: p.overall_power || 0,
                        uid: p.uid || null
                    };
                }
            });

            ocrExtractedPlayers = Object.values(uniqueMap);
            renderOcrResults(ocrExtractedPlayers);
        } catch (err) {
            console.error('OCR processing error:', err);
            showToast(err.message || 'OCR Analysis failed', 'error');
            if (loading) loading.style.display = 'none';
            if (dropzone) dropzone.style.display = 'block';
        }
    }

    function fileToBase64(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = function (e) { reject(e); };
            reader.readAsDataURL(file);
        });
    }

    async function callGeminiOcrBatchApi(batchImageItems, updateStatusCallback) {
        var db = (window.GM && window.GM.db) ? window.GM.db : null;
        var token = localStorage.getItem('gm_token') || '';

        // 1. Try Supabase Edge Function 'ocr-guild-members' (Zero-Trust Serverless)
        if (db && db.functions) {
            try {
                if (updateStatusCallback) updateStatusCallback('Analyzing with AI OCR Edge Function...');
                var headers = token ? { 'Authorization': 'Bearer ' + token } : {};
                var res = await db.functions.invoke('ocr-guild-members', {
                    body: { images: batchImageItems },
                    headers: headers
                });
                if (res.data && res.data.ok && Array.isArray(res.data.players)) {
                    return res.data.players;
                }
                if (res.error) {
                    console.warn('Edge Function OCR returned error, attempting direct API fallback:', res.error);
                }
            } catch (edgeErr) {
                console.warn('Edge Function OCR invoke failed, falling back to direct API:', edgeErr);
            }
        }

        // 2. Direct Gemini Fallback (with authorized CSP)
        var activeKey = getOcrApiKey();
        if (!activeKey) {
            var prompt = document.getElementById('ocr-key-prompt');
            if (prompt) prompt.style.display = 'block';
            throw new Error('API Key Required. Please check your API key configuration.');
        }

        var systemPrompt = 'Extract all visible player pseudos (names) and overall power values from these gaming roster screenshots. Convert power values like 145.2M to integer 145200000. Return JSON matching schema: {"players": [{"pseudo": "string", "overall_power": number, "uid": "string or null"}]}';

        var parts = [{ text: systemPrompt }];
        batchImageItems.forEach(function (item) {
            var cleanBase64 = item.base64Data.includes(';base64,') ? item.base64Data.split(';base64,')[1] : item.base64Data;
            parts.push({
                inline_data: {
                    mime_type: item.mimeType || 'image/png',
                    data: cleanBase64
                }
            });
        });

        var payload = {
            contents: [{ parts: parts }],
            generationConfig: { response_mime_type: 'application/json', temperature: 0.1 }
        };

        var modelsToTry = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3-flash-preview', 'gemini-flash-lite-latest'];
        var maxRetries = 3;
        var lastErr = null;

        for (var m = 0; m < modelsToTry.length; m++) {
            var modelName = modelsToTry[m];
            var apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelName + ':generateContent?key=' + activeKey;
            var attempt = 0;

            while (attempt < maxRetries) {
                attempt++;
                try {
                    var response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });

                    // 429 Rate Limit handling with auto delay
                    if (response.status === 429) {
                        var errBody = '';
                        try { errBody = await response.text(); } catch (e) {}
                        var waitSec = 6;
                        var match = errBody.match(/retryDelay["\s:]+["']?(\d+)/i) || errBody.match(/retry in ([\d\.]+)s/i);
                        if (match && match[1]) {
                            waitSec = Math.max(3, Math.ceil(parseFloat(match[1])));
                        }

                        if (attempt < maxRetries) {
                            if (updateStatusCallback) {
                                updateStatusCallback('API Rate Limit (429). Auto-retrying in ' + waitSec + 's (Attempt ' + attempt + '/' + maxRetries + ')...');
                            }
                            await new Promise(function (r) { setTimeout(r, waitSec * 1000); });
                            continue;
                        } else {
                            lastErr = new Error('API Rate Limit Exceeded (HTTP 429). Please wait a moment and try again.');
                            break;
                        }
                    }

                    // 503 / 500 / 502 / 504 Transient Server Overload handling with retry
                    if (response.status === 503 || response.status === 500 || response.status === 502 || response.status === 504) {
                        var backoffSec = attempt * 2;
                        if (attempt < maxRetries) {
                            if (updateStatusCallback) {
                                updateStatusCallback('Google AI service busy (HTTP ' + response.status + '). Retrying in ' + backoffSec + 's (' + attempt + '/' + maxRetries + ')...');
                            }
                            await new Promise(function (r) { setTimeout(r, backoffSec * 1000); });
                            continue;
                        } else {
                            console.warn('Model ' + modelName + ' returned HTTP ' + response.status + ' after ' + maxRetries + ' attempts. Trying next model...');
                            lastErr = new Error('Google AI server temporarily overloaded (HTTP ' + response.status + '). Please wait 15-30 seconds and try again.');
                            break;
                        }
                    }

                    if (!response.ok) {
                        if (response.status === 403) {
                            var keyPromptBox = document.getElementById('ocr-key-prompt');
                            if (keyPromptBox) keyPromptBox.style.display = 'block';
                            throw new Error('Invalid or missing API Key (HTTP 403). Please enter your API key above.');
                        }
                        if (response.status === 404) {
                            console.warn('Model ' + modelName + ' not available (HTTP 404), trying next model...');
                            lastErr = new Error('OCR API HTTP 404 (Model not found)');
                            break;
                        }
                        throw new Error('OCR API HTTP ' + response.status);
                    }

                    var resJson = await response.json();
                    var jsonText = resJson && resJson.candidates && resJson.candidates[0] && resJson.candidates[0].content && resJson.candidates[0].content.parts && resJson.candidates[0].content.parts[0] ? resJson.candidates[0].content.parts[0].text : '';
                    
                    if (!jsonText) return [];

                    var parsed = parseGeminiJson(jsonText);
                    var rawList = [];
                    if (Array.isArray(parsed)) {
                        rawList = parsed;
                    } else if (parsed && typeof parsed === 'object') {
                        rawList = parsed.players || parsed.members || parsed.roster || parsed.data || [];
                        if (!Array.isArray(rawList)) {
                            var keys = Object.keys(parsed);
                            for (var k = 0; k < keys.length; k++) {
                                if (Array.isArray(parsed[keys[k]])) {
                                    rawList = parsed[keys[k]];
                                    break;
                                }
                            }
                        }
                    }

                    return rawList.map(function (p) {
                        return {
                            pseudo: String(p.pseudo || p.name || p.username || '').trim(),
                            overall_power: typeof p.overall_power === 'number' ? Math.round(p.overall_power) : (typeof p.power === 'number' ? Math.round(p.power) : (parseInt(String(p.overall_power || p.power || '').replace(/[^0-9]/g, ''), 10) || 0)),
                            uid: p.uid ? String(p.uid).trim() : null
                        };
                    }).filter(function (p) { return p.pseudo.length > 0 && p.overall_power >= 0; });
                } catch (err) {
                    lastErr = err;
                    if (err.message && (err.message.includes('403') || err.message.includes('API Key Required'))) {
                        throw err;
                    }
                    if (attempt < maxRetries) {
                        await new Promise(function (r) { setTimeout(r, 1500); });
                    }
                }
            }
        }
        if (lastErr) throw lastErr;
        return [];
    }

    function calculateStringSimilarity(str1, str2) {
        if (!str1 || !str2) return 0;
        var s1 = String(str1).toLowerCase().trim();
        var s2 = String(str2).toLowerCase().trim();
        if (s1 === s2) return 1.0;

        var clean1 = s1.replace(/\[[^\]]*\]|\([^\)]*\)/g, '').replace(/[^a-z0-9]/gi, '');
        var clean2 = s2.replace(/\[[^\]]*\]|\([^\)]*\)/g, '').replace(/[^a-z0-9]/gi, '');
        if (clean1 && clean1 === clean2) return 0.95;

        var len1 = s1.length;
        var len2 = s2.length;
        var maxLen = Math.max(len1, len2);
        if (maxLen === 0) return 1.0;

        var dist = levenshteinDistance(s1, s2);
        var sim = 1.0 - (dist / maxLen);

        var cleanMax = Math.max(clean1.length, clean2.length);
        if (cleanMax > 0) {
            var cleanDist = levenshteinDistance(clean1, clean2);
            var cleanSim = 1.0 - (cleanDist / cleanMax);
            if (cleanSim > sim) sim = cleanSim;
        }

        return sim;
    }

    function levenshteinDistance(a, b) {
        var matrix = [];
        for (var i = 0; i <= b.length; i++) { matrix[i] = [i]; }
        for (var j = 0; j <= a.length; j++) { matrix[0][j] = j; }
        for (var i = 1; i <= b.length; i++) {
            for (var j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                    );
                }
            }
        }
        return matrix[b.length][a.length];
    }

    function findBestMatchingMember(ocrPseudo, members) {
        if (!ocrPseudo || !members || !Array.isArray(members) || members.length === 0) return null;
        var target = String(ocrPseudo).trim().toLowerCase();

        var exact = members.find(function (m) {
            return m.pseudo && m.pseudo.trim().toLowerCase() === target;
        });
        if (exact) return { member: exact, matchType: 'exact', score: 1.0 };

        var targetClean = target.replace(/\[[^\]]*\]|\([^\)]*\)/g, '').replace(/[^a-z0-9]/gi, '');
        if (targetClean.length >= 3) {
            var normMatch = members.find(function (m) {
                var mClean = (m.pseudo || '').trim().toLowerCase().replace(/\[[^\]]*\]|\([^\)]*\)/g, '').replace(/[^a-z0-9]/gi, '');
                return mClean === targetClean;
            });
            if (normMatch) return { member: normMatch, matchType: 'normalized', score: 0.95 };
        }

        var bestMember = null;
        var bestScore = 0;

        members.forEach(function (m) {
            if (!m || !m.pseudo) return;
            var score = calculateStringSimilarity(ocrPseudo, m.pseudo);
            if (score > bestScore) {
                bestScore = score;
                bestMember = m;
            }
        });

        if (bestMember && bestScore >= 0.75) {
            return { member: bestMember, matchType: 'fuzzy', score: bestScore };
        }

        return null;
    }

    function renderOcrResults(players) {
        var loading = document.getElementById('ocr-loading');
        var resultsContainer = document.getElementById('ocr-results-container');
        var tbody = document.getElementById('ocr-results-tbody');
        var countSpan = document.getElementById('ocr-detected-count');
        var summaryBadges = document.getElementById('ocr-summary-badges');
        var btnCommit = document.getElementById('ocr-commit-btn');

        var esc = (window.GM && window.GM.escapeHTML) ? window.GM.escapeHTML : function (s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        };
        var fmtNum = (window.GM && window.GM.formatNumber) ? window.GM.formatNumber : function (n) {
            return String(n || 0);
        };

        if (loading) loading.style.display = 'none';
        if (resultsContainer) resultsContainer.style.display = 'block';
        if (btnCommit) btnCommit.style.display = 'inline-flex';

        if (countSpan) countSpan.textContent = players ? players.length : 0;

        if (!players || players.length === 0) {
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:2rem; color:var(--text-muted);"><i class="ph ph-warning-circle" style="font-size:1.5rem; display:block; margin-bottom:0.5rem; color:#facc15;"></i>No player usernames or power values were detected in the uploaded image(s). Please try clearer roster screenshots.</td></tr>';
            }
            if (summaryBadges) {
                summaryBadges.innerHTML = '<span class="gm-chip" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);"><i class="ph ph-x-circle"></i> 0 Detected</span>';
            }
            updateCommitButtonCount();
            return;
        }

        var newCount = 0;
        var updateCount = 0;
        var unchangedCount = 0;
        var reconciledCount = 0;

        var html = '';
        players.forEach(function (p, idx) {
            var matchRes = findBestMatchingMember(p.pseudo, guildMembers);
            var existing = matchRes ? matchRes.member : null;
            var matchType = matchRes ? matchRes.matchType : null;

            var effectivePseudo = p.pseudo;
            if (existing && (matchType === 'normalized' || matchType === 'fuzzy') && p.pseudo !== existing.pseudo) {
                effectivePseudo = existing.pseudo;
                p.pseudo = existing.pseudo;
                reconciledCount++;
            }

            var badgeHtml = '';
            if (!existing) {
                newCount++;
                badgeHtml = '<span class="gm-chip gm-chip-success"><i class="ph ph-user-plus"></i> New Player</span>';
            } else if (matchType === 'fuzzy' || matchType === 'normalized') {
                updateCount++;
                badgeHtml = '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-sparkle"></i> Reconciled ("' + esc(existing.pseudo) + '") &rarr; ' + fmtNum(p.overall_power) + '</span>';
            } else if (existing.overall_power !== p.overall_power) {
                updateCount++;
                badgeHtml = '<span class="gm-chip" style="background:rgba(99,102,241,0.15); color:#818cf8; border:1px solid rgba(99,102,241,0.3);"><i class="ph ph-arrows-clockwise"></i> Update (' + fmtNum(existing.overall_power) + ' &rarr; ' + fmtNum(p.overall_power) + ')</span>';
            } else {
                unchangedCount++;
                badgeHtml = '<span class="gm-chip" style="background:rgba(255,255,255,0.05); color:var(--text-muted);"><i class="ph ph-check"></i> Unchanged</span>';
            }

            html += '<tr>' +
                '<td style="text-align: center;"><input type="checkbox" class="ocr-row-cb" data-index="' + idx + '" checked></td>' +
                '<td><input type="text" class="ocr-edit-pseudo gm-input" data-index="' + idx + '" value="' + esc(effectivePseudo) + '" style="padding:0.25rem 0.5rem; font-size:0.85rem; font-weight:600; width:100%; max-width:180px;"></td>' +
                '<td><input type="number" class="ocr-edit-power gm-input" data-index="' + idx + '" value="' + p.overall_power + '" style="padding:0.25rem 0.5rem; font-size:0.85rem; font-weight:600; color:var(--accent); width:100%; max-width:140px;"></td>' +
                '<td>' + badgeHtml + '</td>' +
            '</tr>';
        });

        if (summaryBadges) {
            summaryBadges.innerHTML = 
                '<span class="gm-chip gm-chip-success"><i class="ph ph-user-plus"></i> ' + newCount + ' New</span>' +
                '<span class="gm-chip" style="background:rgba(99,102,241,0.15); color:#818cf8; border:1px solid rgba(99,102,241,0.3);"><i class="ph ph-arrows-clockwise"></i> ' + updateCount + ' Updates</span>' +
                (reconciledCount > 0 ? '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-sparkle"></i> ' + reconciledCount + ' Reconciled</span>' : '') +
                '<span class="gm-chip" style="background:rgba(255,255,255,0.05); color:var(--text-muted);"><i class="ph ph-check"></i> ' + unchangedCount + ' Unchanged</span>';
        }

        if (tbody) tbody.innerHTML = html;

        updateCommitButtonCount();

        if (tbody) {
            tbody.querySelectorAll('.ocr-row-cb').forEach(function (cb) {
                cb.addEventListener('change', updateCommitButtonCount);
            });

            tbody.querySelectorAll('.ocr-edit-pseudo').forEach(function (input) {
                input.addEventListener('input', function () {
                    var idx = parseInt(input.getAttribute('data-index'), 10);
                    if (ocrExtractedPlayers[idx]) {
                        ocrExtractedPlayers[idx].pseudo = input.value.trim();
                    }
                });
            });

            tbody.querySelectorAll('.ocr-edit-power').forEach(function (input) {
                input.addEventListener('input', function () {
                    var idx = parseInt(input.getAttribute('data-index'), 10);
                    if (ocrExtractedPlayers[idx]) {
                        ocrExtractedPlayers[idx].overall_power = parseInt(input.value, 10) || 0;
                    }
                });
            });
        }
    }

    function toggleAllCheckboxes(checked) {
        var tbody = document.getElementById('ocr-results-tbody');
        if (!tbody) return;
        tbody.querySelectorAll('.ocr-row-cb').forEach(function (cb) {
            cb.checked = checked;
        });
        updateCommitButtonCount();
    }

    function updateCommitButtonCount() {
        var btnCommit = document.getElementById('ocr-commit-btn');
        var tbody = document.getElementById('ocr-results-tbody');
        if (!btnCommit || !tbody) return;

        var selectedCbs = tbody.querySelectorAll('.ocr-row-cb:checked');
        var count = selectedCbs.length;
        var span = btnCommit.querySelector('span');
        if (span) span.textContent = 'Validate & Apply Updates (' + count + ')';
        btnCommit.disabled = count === 0;
    }

    async function commitOcrUpdates() {
        var tbody = document.getElementById('ocr-results-tbody');
        var btnCommit = document.getElementById('ocr-commit-btn');
        if (!tbody || !btnCommit) return;

        var selectedIndices = [];
        tbody.querySelectorAll('.ocr-row-cb:checked').forEach(function (cb) {
            selectedIndices.push(parseInt(cb.getAttribute('data-index'), 10));
        });

        if (selectedIndices.length === 0) {
            showToast('No players selected.', 'error');
            return;
        }

        var selectedPlayers = selectedIndices.map(function (idx) { return ocrExtractedPlayers[idx]; });

        btnCommit.disabled = true;
        var span = btnCommit.querySelector('span');
        if (span) span.textContent = 'Validating & Saving...';

        try {
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            
            var rpcRes = await supabase.rpc('gm_bulk_upsert_members', { p_members: selectedPlayers, p_guild: currentG });
            
            if (rpcRes.error) {
                console.warn('RPC gm_bulk_upsert_members failed, falling back to direct upserts:', rpcRes.error);
                for (var i = 0; i < selectedPlayers.length; i++) {
                    var sp = selectedPlayers[i];
                    var existing = guildMembers.find(function (m) { return m.pseudo.toLowerCase() === sp.pseudo.toLowerCase(); });
                    if (existing) {
                        await supabase.from('guild_members').update({
                            overall_power: sp.overall_power,
                            power_updated_at: new Date().toISOString()
                        }).eq('guild', currentG).eq('pseudo', existing.pseudo);
                    } else {
                        await supabase.from('guild_members').insert([{
                            pseudo: sp.pseudo,
                            uid: sp.uid || ('TEMP-' + Math.random().toString(36).substring(2, 10)),
                            overall_power: sp.overall_power,
                            guild: currentG,
                            role: 'R1'
                        }]);
                    }
                }
            }

            showToast(selectedPlayers.length + ' member(s) successfully validated and updated!', 'success');
            
            var modal = document.getElementById('ocr-modal-overlay');
            if (modal) {
                modal.classList.remove('visible');
                modal.style.display = 'none';
            }

            fetchGuildMembers();
        } catch (err) {
            console.error('Commit OCR failed:', err);
            showToast('Error saving member updates: ' + err.message, 'error');
        } finally {
            btnCommit.disabled = false;
            if (span) span.textContent = 'Validate & Apply Updates';
        }
    }

    // ─── Guild Members & Transfers ──────────────────────────────────────────
    var pendingTransfers = [];

    async function fetchGuildMembers() {
        if (!supabase) return;
        initOcrGeminiModule();
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        try {
            var [res, transfersRes, absencesRes] = await Promise.all([
                supabase.from('guild_members').select('*').eq('guild', currentG).order('pseudo', { ascending: true }),
                supabase.from('guild_transfers').select('id, uid, pseudo, source_guild, target_guild').eq('status', 'pending').order('created_at', { ascending: true }),
                supabase.from('player_absences').select('*').eq('guild', currentG)
            ]);
            
            if (res.error) throw res.error;
            guildMembers = res.data || [];
            
            if (!transfersRes.error) {
                var currentGTransfers = (transfersRes.data || []).filter(function (t) {
                    return t.target_guild === currentG || t.source_guild === currentG;
                });
                pendingTransfers = currentGTransfers;
            }

            if (!absencesRes.error) {
                window.guildAbsences = absencesRes.data || [];
            } else {
                window.guildAbsences = [];
            }
            
            renderPendingTransfers();
            renderGuildMembers();
        } catch (err) {
            showToast(t('toast_err_fetch_members') + ' ' + err.message, 'error');
        }
    }

    function renderPendingTransfers() {
        var section = document.getElementById('admin-pending-transfers-section');
        var list = document.getElementById('admin-pending-transfers-list');
        var count = document.getElementById('pending-transfers-count');
        if (!section || !list || !count) return;

        if (pendingTransfers.length === 0) {
            section.style.display = 'none';
            return;
        }

        section.style.display = '';
        count.textContent = pendingTransfers.length;

        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';

        var html = '';
        pendingTransfers.forEach(function (t) {
            // Direction from the current admin's point of view.
            var isIncoming = t.target_guild === currentG;
            var directionBadge = isIncoming
                ? '<span class="gm-chip gm-chip-success" style="font-size:0.68rem;"><i class="ph ph-arrow-down-left"></i> IN</span>'
                : '<span class="gm-chip" style="font-size:0.68rem; background:rgba(251,191,36,0.12); color:#fbbf24; border:1px solid rgba(251,191,36,0.3);"><i class="ph ph-arrow-up-right"></i> OUT</span>';

            var actions = '';
            if (isIncoming) {
                // Only the target guild (or super admin) can resolve.
                actions =
                    '<button type="button" class="gm-btn gm-btn-sm gm-btn-success" onclick="window.GM.resolveTransfer(\'' + t.id + '\', \'approve\')" style="margin-right: 0.25rem;" title="Approve Transfer"><i class="ph ph-check"></i></button>' +
                    '<button type="button" class="gm-btn gm-btn-sm gm-btn-danger" onclick="window.GM.resolveTransfer(\'' + t.id + '\', \'reject\')" title="Reject Transfer"><i class="ph ph-x"></i></button>';
            } else {
                // Outgoing: another guild must approve; show a waiting hint.
                actions = '<span style="font-size:0.72rem; color:var(--text-dim);"><i class="ph ph-hourglass"></i> Awaiting approval from ' + esc(t.target_guild) + '</span>';
            }

            html += '<tr>' +
                '<td data-label="Player"><div class="gm-member-name"><div class="gm-avatar gm-avatar-sm gm-avatar-info">' + esc(window.GM.avatarInit(t.pseudo)) + '</div>' + esc(t.pseudo) + '</div></td>' +
                '<td data-label="UID"><div class="gm-uid-badge">' + esc(t.uid) + '</div></td>' +
                '<td data-label="Direction">' + directionBadge + '</td>' +
                '<td data-label="From">' + esc(t.source_guild) + ' &rarr; ' + esc(t.target_guild) + '</td>' +
                '<td class="gm-center" data-label="Actions" style="white-space: nowrap;">' + actions + '</td>' +
            '</tr>';
        });
        list.innerHTML = html;
    }

    window.GM = window.GM || {};
    window.GM.resolveTransfer = async function(transferId, action) {
        if (!supabase) return;
        var confirmMsg = action === 'approve' ? 'Approve this transfer and add player to your guild?' : 'Reject this transfer request?';
        if (!confirm(confirmMsg)) return;

        try {
            var { data, error } = await supabase.rpc('resolve_guild_transfer', {
                p_transfer_id: transferId,
                p_action: action
            });

            if (error || !data || !data.ok) {
                var errStr = (data && data.error) ? data.error : (error ? error.message : 'unknown');
                showToast('Failed to ' + action + ' transfer: ' + errStr, 'error');
            } else {
                showToast('Transfer ' + action + 'd successfully.', 'success');
                fetchGuildMembers();
            }
        } catch (err) {
            console.error(err);
            showToast('Error processing transfer.', 'error');
        }
    };

    // ── UID already taken: show where the player lives + transfer request ──
    // info comes from gm_find_player_by_uid: { player, name_history }
    async function showUidTakenDialog(typedPseudo, uid, info) {
        var existing = document.getElementById('uid-taken-overlay');
        if (existing) existing.remove();

        var p = info.player || {};
        var server = p.server_number ? 'Server #' + p.server_number : 'Server unknown';
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';

        var historyHtml = '';
        var history = info.name_history || [];
        if (history.length > 0) {
            var items = history.slice(0, 5).map(function (h) {
                return '<div style="font-size:0.8rem; color:var(--text-dim);">' +
                    '<span style="color:var(--text-muted); text-decoration:line-through;">' + esc(h.old_pseudo) + '</span>' +
                    ' &rarr; <span style="color:var(--accent); font-weight:600;">' + esc(h.new_pseudo) + '</span>' +
                    '<span style="margin-left:0.5rem; font-size:0.7rem;">(' + esc(String(h.changed_at || '').slice(0, 10)) + ')</span>' +
                '</div>';
            }).join('');
            historyHtml =
                '<div style="margin-top:0.75rem; border-top:1px solid var(--border-soft); padding-top:0.65rem;">' +
                    '<div style="font-size:0.72rem; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--text-muted); margin-bottom:0.35rem;">Name history</div>' +
                    '<div style="display:flex; flex-direction:column; gap:0.2rem;">' + items + '</div>' +
                '</div>';
        }

        var overlay = document.createElement('div');
        overlay.id = 'uid-taken-overlay';
        overlay.className = 'confirm-overlay';

        overlay.innerHTML =
            '<div class="gm-modal-card" style="max-width: 520px; width: 92%; position: relative; text-align:left;">' +
                '<div class="gm-modal-header" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:1rem;">' +
                    '<div style="display:flex; align-items:center; gap:0.5rem;">' +
                        '<i class="ph ph-user-circle-gear" style="font-size:1.5rem; color:var(--accent);"></i>' +
                        '<h3 style="margin:0; font-size:1.2rem;">Player ID already exists</h3>' +
                    '</div>' +
                    '<button type="button" class="gm-mini-btn gm-close-uid" style="cursor:pointer;"><i class="ph ph-x"></i></button>' +
                '</div>' +
                '<div style="background: rgba(255,255,255,0.03); border:1px solid var(--border-soft); border-radius:8px; padding:0.9rem; display:flex; flex-direction:column; gap:0.4rem;">' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Player</span><strong style="color:var(--fg);">' + esc(p.pseudo || typedPseudo) + '</strong></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Player ID</span><span class="gm-uid-badge">' + esc(uid) + '</span></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Current Guild</span><strong style="color:var(--accent);">' + esc(p.guild || '?') + '</strong></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Server</span><span>' + esc(server) + '</span></div>' +
                    (p.role ? '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Rank</span><span>' + esc(p.role) + '</span></div>' : '') +
                    historyHtml +
                '</div>' +
                '<div style="background: var(--info-soft); color: var(--info); padding:0.75rem; border-radius:6px; border:1px solid var(--info-soft); font-size:0.8rem; line-height:1.45; margin-top:0.85rem;">' +
                    '<i class="ph ph-info" style="margin-right:4px;"></i>' +
                    'This player already belongs to <strong>' + esc(p.guild || 'another guild') + '</strong>. You cannot add them directly here. You can send a transfer request so an admin approves moving them to <strong>' + esc(currentG) + '</strong>.' +
                '</div>' +
                '<label style="display:flex; align-items:flex-start; gap:0.5rem; margin-top:0.85rem; cursor:pointer; font-size:0.82rem; color:var(--text-muted);">' +
                    '<input type="checkbox" id="uid-taken-confirm" style="margin-top:2px; accent-color: var(--accent);">' +
                    '<span>I understand this process cannot be undone without reporting an issue or bug, and that the transfer must be approved by an admin.</span>' +
                '</label>' +
                '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:1.4rem;">' +
                    '<button type="button" class="gm-btn gm-btn-ghost gm-close-uid">Cancel</button>' +
                    '<button type="button" id="uid-taken-request-btn" class="gm-btn gm-btn-primary" disabled>' +
                        '<i class="ph ph-arrows-left-right"></i> <span>Request Transfer</span>' +
                    '</button>' +
                '</div>' +
            '</div>';

        document.body.appendChild(overlay);
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        function closeDialog() {
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 200);
        }
        overlay.querySelectorAll('.gm-close-uid').forEach(function (btn) {
            btn.addEventListener('click', closeDialog);
        });
        overlay.addEventListener('click', function (ev) {
            if (ev.target === overlay) closeDialog();
        });

        var confirmCb = document.getElementById('uid-taken-confirm');
        var requestBtn = document.getElementById('uid-taken-request-btn');
        if (confirmCb) {
            confirmCb.addEventListener('change', function () {
                if (requestBtn) requestBtn.disabled = !confirmCb.checked;
            });
        }

        if (requestBtn) {
            requestBtn.addEventListener('click', async function () {
                requestBtn.disabled = true;
                var span = requestBtn.querySelector('span');
                if (span) span.textContent = 'Requesting...';
                try {
                    var res = await supabase.rpc('gm_admin_request_transfer', { p_uid: uid, p_target_guild: currentG });
                    if (res.error) throw res.error;
                    var data = res.data || {};
                    if (!data.ok) throw new Error(data.error || 'request_failed');
                    closeDialog();
                    showToast('Transfer request sent to ' + currentG + '. It will appear in the pending list for approval.', 'success');
                    fetchGuildMembers();
                } catch (err) {
                    showToast('Could not request transfer: ' + err.message, 'error');
                    requestBtn.disabled = false;
                    if (span) span.textContent = 'Request Transfer';
                }
            });
        }
    }

    async function handleAddMember(inputId, uidInputId, powerInputId, roleInputId) {
        var input  = document.getElementById(inputId);
        var pseudo = input ? input.value.trim() : '';
        var uidInput = document.getElementById(uidInputId);
        var uidVal = uidInput ? uidInput.value.trim() : null;
        var powerInput = powerInputId ? document.getElementById(powerInputId) : null;
        var powerVal = powerInput && powerInput.value ? parseInt(powerInput.value, 10) : NaN;
        var roleInput = roleInputId ? document.getElementById(roleInputId) : null;
        var roleVal = roleInput ? roleInput.value : 'R1';
        if (!pseudo || !uidVal || isNaN(powerVal) || powerVal < 0) {
            showToast('Please enter a valid power value.', 'error');
            return;
        }

        var pseudoErr = window.GM.validatePseudo(pseudo);
        if (pseudoErr) { showToast(t(pseudoErr), 'error'); return; }
        var uidErr = window.GM.validateUid(uidVal);
        if (uidErr) { showToast(t(uidErr), 'error'); return; }

        if (guildMembers.some(function (m) { return m.pseudo.toLowerCase() === pseudo.toLowerCase(); })) {
            showToast(t('toast_duplicate_member'), 'error');
            return;
        }

        try {
            var uidCheck = await supabase.rpc('check_uid_exists_globally', { p_uid: String(uidVal).trim() });
            if (uidCheck.error) throw uidCheck.error;
            if (uidCheck.data) {
                // The UID exists somewhere: show where the player currently
                // lives and offer a transfer request instead of blocking.
                var lookup = await supabase.rpc('gm_find_player_by_uid', { p_uid: String(uidVal).trim() });
                if (lookup.error) throw lookup.error;
                var info = lookup.data || {};
                if (!info.ok) throw new Error(info.error || 'lookup_failed');
                if (info.found) {
                    showUidTakenDialog(pseudo, uidVal, info);
                    return;
                }
                // Fallback: global check says it exists but lookup found nothing.
                showToast('Player ID is already in use. Use Transfer instead.', 'error');
                return;
            }
        } catch (err) {
            console.error('Global UID check failed', err);
            // Fallback to local check if RPC fails
            if (guildMembers.some(function (m) { return m.uid && String(m.uid).trim() === String(uidVal).trim(); })) {
                showToast(t('toast_duplicate_uid'), 'error');
                return;
            }
        }

        try {
            var banCheck = await supabase.from('banned_players').select('uid').eq('uid', uidVal);
            if (banCheck.error) throw banCheck.error;
            if (banCheck.data && banCheck.data.length > 0) {
                showToast(t('toast_cannot_add_banned_player'), 'error');
                return;
            }
        } catch (err) {
            console.error('Ban check failed', err);
        }
        try {
            var currentG = window.currentGuildRestriction || window.currentGuild || localStorage.getItem('gm_current_guild') || 'ALPHA';
            var res = await supabase.from('guild_members').insert([{ pseudo: pseudo, uid: uidVal, overall_power: powerVal, role: roleVal, guild: currentG }]);
            if (res.error) throw res.error;
            guildMembers.push({ pseudo: pseudo, uid: uidVal, overall_power: powerVal, role: roleVal, guild: currentG, created_at: new Date().toISOString() });
            if (input) input.value = '';
            if (uidInput) uidInput.value = '';
            if (powerInput) powerInput.value = '';
            if (roleInput) roleInput.value = 'R1';
            renderGuildMembers();
            showToast(pseudo + ' ' + t('toast_member_added'), 'success');

            var addedEvents = 0;
            var activeG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            try {
                // Reliable DB-side enrollment: adds the member to every active
                // event of the guild (Arms Race, DTR, SvS, GvG) regardless of
                // which UI tabs were visited. Shadowfront is excluded by design.
                var enrollRes = await supabase.rpc('gm_add_member_to_active_events', { p_pseudo: pseudo, p_guild: activeG });
                if (!enrollRes.error && typeof enrollRes.data === 'number') {
                    addedEvents = enrollRes.data;
                }
            } catch (err) {
                console.error('Auto-enroll into active events failed', err);
            }
            // Refresh the in-memory states so open tabs reflect the new member.
            // The client helpers are idempotent (upsert), so running them after
            // the RPC only re-syncs the UI without creating duplicates.
            if (window.GM_EVENTS && window.GM_EVENTS.addMemberToActiveEvents) {
                await window.GM_EVENTS.addMemberToActiveEvents(pseudo);
            }
            if (window.GM_ARMSRACE && window.GM_ARMSRACE.addMemberToActiveEvents) {
                await window.GM_ARMSRACE.addMemberToActiveEvents(pseudo);
            }
            if (window.GM_SHADOWFRONT && window.GM_SHADOWFRONT.load) {
                await window.GM_SHADOWFRONT.load();
            }
            if (addedEvents > 0) {
                showToast(pseudo + ' ' + t('toast_member_added_active_events'), 'info');
            }
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    if (addMemberForm)  addMemberForm.addEventListener('submit', function (e)  { e.preventDefault(); handleAddMember('member-pseudo', 'member-uid', 'member-power', 'member-role'); });
    if (addMemberFormM) addMemberFormM.addEventListener('submit', function (e) { e.preventDefault(); handleAddMember('member-pseudo-m', 'member-uid-m', 'member-power-m', 'member-role-m'); });
    if (addBannedForm) {
        addBannedForm.addEventListener('submit', function (e) { e.preventDefault(); handleAddBannedPlayer(); });
    }

    var searchAdmin = document.getElementById('member-search-admin');
    if (searchAdmin) searchAdmin.addEventListener('input', renderGuildMembers);
    var searchMember = document.getElementById('member-search-member');
    if (searchMember) searchMember.addEventListener('input', renderGuildMembers);
    var tierAdminSelect = document.getElementById('member-tier-filter-admin');
    if (tierAdminSelect) tierAdminSelect.addEventListener('change', renderGuildMembers);
    var tierMemberSelect = document.getElementById('member-tier-filter-member');
    if (tierMemberSelect) tierMemberSelect.addEventListener('change', renderGuildMembers);
    var sortAdminSelect = document.getElementById('member-sort-admin');
    if (sortAdminSelect) sortAdminSelect.addEventListener('change', renderGuildMembers);
    var sortMemberSelect = document.getElementById('member-sort-member');
    if (sortMemberSelect) sortMemberSelect.addEventListener('change', renderGuildMembers);
    if (bannedSearch) {
        bannedSearch.addEventListener('input', renderBannedPlayers);
    }

    async function deleteGuildMember(pseudo) {
        try {
            // ON DELETE CASCADE fait le ménage côté DB sur :
            //   event_participants, shadowfront_squads, weekly_scores, sanctions
            var res = await supabase.from('guild_members').delete().eq('pseudo', pseudo);
            if (res.error) throw res.error;
            guildMembers = guildMembers.filter(function (m) { return m.pseudo !== pseudo; });
            renderGuildMembers();
            showToast(t('toast_member_removed'), 'success');

            if (window.GM_EVENTS && window.GM_EVENTS.removeMemberFromActiveEvents) {
                window.GM_EVENTS.removeMemberFromActiveEvents(pseudo);
            }
            if (window.GM_ARMSRACE && window.GM_ARMSRACE.removeMemberFromActiveEvents) {
                window.GM_ARMSRACE.removeMemberFromActiveEvents(pseudo);
            }
            if (window.GM_SHADOWFRONT && window.GM_SHADOWFRONT.load) {
                await window.GM_SHADOWFRONT.load();
            }
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    // ─── Banned Players CRUD ───────────────────────────────────────────────────
    async function fetchBannedPlayers() {
        if (!supabase) return;
        try {
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            var res = await supabase.from('banned_players').select('*').eq('guild', currentG).order('created_at', { ascending: false });
            if (res.error) throw res.error;
            bannedPlayers = res.data || [];
            renderBannedPlayers();
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    function renderBannedPlayers() {
        if (!bannedListContainer) return;
        var q = bannedSearch ? bannedSearch.value.toLowerCase() : '';
        var filtered = bannedPlayers.filter(function (bp) {
            return (bp.uid.toLowerCase() + ' ' + (bp.pseudo || '').toLowerCase() + ' ' + (bp.reason || '').toLowerCase()).indexOf(q) !== -1;
        });

        if (bannedCount) bannedCount.textContent = filtered.length;

        if (filtered.length === 0) {
            bannedListContainer.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_banned') + '</div></div>';
            return;
        }

        var html = '<div class="gm-member-list">';
        var lang = (window.GM_I18N && window.GM_I18N.getLang) ? window.GM_I18N.getLang() : 'en';
        var locale = lang === 'fr' ? 'fr-FR' : 'en-GB';
        var uidPrefix = t('banned_uid_prefix');
        var reasonLabel = t('banned_reason_label');
        var byLabel = t('banned_by_label');
        var onLabel = t('banned_on_label');
        var fallbackName = t('banned_fallback_name');

        filtered.forEach(function (bp) {
            var dateStr = bp.created_at
                ? new Date(bp.created_at).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '-';
            var pseudoVal = bp.pseudo || '-';
            var reasonVal = bp.reason || '-';
            var author = bp.created_by || '-';
            var initial = window.GM.avatarInit(pseudoVal !== '-' ? pseudoVal : fallbackName);
            
            html += '<div class="gm-member-row" data-uid="' + esc(bp.uid) + '">' +
                '<div class="gm-member-id">' +
                    '<div class="gm-avatar" style="background: var(--danger-soft); color: var(--danger); border-color: var(--danger-soft);">' + esc(initial) + '</div>' +
                    '<div class="gm-grow gm-truncate">' +
                        '<div class="gm-mono gm-truncate" style="color: var(--danger); font-weight: 700; font-size: 1.25rem;">' + esc(uidPrefix) + ' ' + esc(bp.uid) + '</div>' +
                        '<div class="gm-member-pseudo gm-dim gm-truncate" style="font-weight: 500; font-size: 0.85rem; margin-top: 2px;">' + esc(pseudoVal) + '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="gm-col gm-dim" style="gap:.2rem; font-size:.8rem; flex: 1.5; min-width: 150px;">' +
                    '<span><strong>' + esc(reasonLabel) + '</strong> ' + esc(reasonVal) + '</span>' +
                    '<span>' + esc(byLabel) + ' <strong>' + esc(author) + '</strong> ' + esc(onLabel) + ' ' + dateStr + '</span>' +
                '</div>' +
                '<div class="gm-member-actions">' +
                    '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm banned-delete-btn" data-uid="' + esc(bp.uid) + '" title="' + t('delete_title') + '" style="color: var(--danger);"><i class="ph ph-trash"></i></button>' +
                '</div>' +
            '</div>';
        });
        html += '</div>';
        bannedListContainer.innerHTML = html;

        bannedListContainer.querySelectorAll('.banned-delete-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var uid = btn.getAttribute('data-uid');
                showConfirm(
                    t('confirm_unban_title'),
                    t('confirm_unban_body') + ' <strong>' + esc(uid) + '</strong> ?',
                    function () { deleteBannedPlayer(uid); }
                );
            });
        });
    }

    async function handleAddBannedPlayer() {
        var uidInput = document.getElementById('banned-uid');
        var pseudoInput = document.getElementById('banned-pseudo');
        var reasonInput = document.getElementById('banned-reason');

        var uidVal = uidInput ? uidInput.value.trim() : '';
        var pseudoVal = pseudoInput ? pseudoInput.value.trim() : '';
        var reasonVal = reasonInput ? reasonInput.value.trim() : '';

        if (!uidVal) return;

        var uidErr = window.GM.validateUid(uidVal);
        if (uidErr) { showToast(t(uidErr), 'error'); return; }

        if (bannedPlayers.some(function (bp) { return bp.uid === uidVal; })) {
            showToast(t('toast_player_already_banned'), 'error');
            return;
        }

        var btn = addBannedForm.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;

        try {
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            var currentUser = window.GM.currentAccountId || localStorage.getItem('gm_user') || 'Admin';
            var res = await supabase.from('banned_players').insert([{
                guild: currentG,
                uid: uidVal,
                pseudo: pseudoVal || null,
                reason: reasonVal || null,
                created_by: currentUser
            }]);

            if (res.error) throw res.error;

            if (uidInput) uidInput.value = '';
            if (pseudoInput) pseudoInput.value = '';
            if (reasonInput) reasonInput.value = '';

            var kickMsg = '';
            // Check if member is in guild and delete
            var member = guildMembers.find(function (m) { return m.uid === uidVal; });
            if (member) {
                var delRes = await supabase.from('guild_members').delete().eq('uid', uidVal).eq('guild', currentG);
                if (!delRes.error) {
                    guildMembers = guildMembers.filter(function (m) { return m.uid !== uidVal; });
                    renderGuildMembers();
                    kickMsg = t('toast_player_banned_kick');
                }
            }

            showToast(t('toast_player_banned_ok') + kickMsg, 'success');
            await fetchBannedPlayers();
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function deleteBannedPlayer(uid) {
        try {
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            var res = await supabase.from('banned_players').delete().eq('uid', uid).eq('guild', currentG);
            if (res.error) throw res.error;
            showToast(t('toast_player_unbanned_ok'), 'success');
            await fetchBannedPlayers();
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    async function renameGuildMember(oldPseudo, newPseudo, newUid, newPower, newRole) {
        newPseudo = (newPseudo || '').trim();
        newUid    = (newUid || '').trim();
        var powerVal = parseInt(newPower) || 0;
        var roleVal = newRole || 'R1';

        var pseudoErr = window.GM.validatePseudo(newPseudo);
        if (pseudoErr) { showToast(t(pseudoErr), 'error'); return false; }
        var uidErr = window.GM.validateUid(newUid);
        if (uidErr) { showToast(t(uidErr), 'error'); return false; }

        var member = guildMembers.find(function (m) { return m.pseudo === oldPseudo; });
        var oldPower = member ? parseInt(member.overall_power) || 0 : 0;
        var oldRole = member ? member.role || 'R1' : 'R1';

        var pseudoChanged = newPseudo.toLowerCase() !== oldPseudo.toLowerCase();
        var uidChanged    = member && (member.uid || '') !== newUid;
        var powerChanged  = oldPower !== powerVal;
        var roleChanged   = oldRole !== roleVal;

        if (!pseudoChanged && !uidChanged && !powerChanged && !roleChanged) return true;

        if (pseudoChanged && guildMembers.some(function (m) { return m.pseudo.toLowerCase() === newPseudo.toLowerCase(); })) {
            showToast(t('toast_duplicate_member'), 'error');
            return false;
        }
        if (uidChanged && newUid && guildMembers.some(function (m) { return m.pseudo !== oldPseudo && (m.uid || '') === newUid; })) {
            showToast(t('toast_duplicate_uid'), 'error');
            return false;
        }

        if (uidChanged && newUid) {
            try {
                var banCheck = await supabase.from('banned_players').select('uid').eq('uid', newUid);
                if (banCheck.error) throw banCheck.error;
                if (banCheck.data && banCheck.data.length > 0) {
                    showToast(t('toast_cannot_rename_banned_player'), 'error');
                    return false;
                }
            } catch (err) {
                console.error('Ban check failed', err);
            }
        }

        try {
            // Log pseudo change history
            if (pseudoChanged && member && member.uid) {
                var histIns = await supabase.from('player_name_history').insert({
                    guild: window.GM.getActiveGuild(),
                    uid: member.uid,
                    old_pseudo: oldPseudo,
                    new_pseudo: newPseudo,
                    changed_by: window.GM.currentAccountId || localStorage.getItem('gm_user') || 'Admin'
                });
                if (histIns.error) console.error('Logging name history failed', histIns.error);
            }

            var update = {};
            if (pseudoChanged) update.pseudo = newPseudo;
            if (uidChanged)    update.uid = newUid || null;
            update.overall_power = powerVal;
            update.role = roleVal;

            var res = await supabase.from('guild_members').update(update).eq('pseudo', oldPseudo);
            if (res.error) throw res.error;

            await fetchGuildMembers();
            showToast(t('toast_member_updated'), 'success');
            return true;
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
            return false;
        }
    }

    function renderGuildMembers() {
        var qAdminInput  = document.getElementById('member-search-admin');
        var qMemberInput = document.getElementById('member-search-member');
        var qAdmin  = qAdminInput  ? qAdminInput.value.toLowerCase()  : '';
        var qMember = qMemberInput ? qMemberInput.value.toLowerCase() : '';

        var tierAdminFilter  = document.getElementById('member-tier-filter-admin');
        var tierMemberFilter = document.getElementById('member-tier-filter-member');
        var tAdmin  = tierAdminFilter  ? tierAdminFilter.value  : 'ALL';
        var tMember = tierMemberFilter ? tierMemberFilter.value : 'ALL';

        var sortAdminSelect  = document.getElementById('member-sort-admin');
        var sortMemberSelect = document.getElementById('member-sort-member');
        var sortAdmin  = sortAdminSelect  ? sortAdminSelect.value  : 'power_desc';
        var sortMember = sortMemberSelect ? sortMemberSelect.value : 'power_desc';

        renderAbsenceSummary();
        renderTimezoneCoverage();

        var powers = guildMembers.map(function (m) { return parseInt(m.overall_power) || 0; });
        var maxPower = powers.length ? Math.max.apply(null, powers) : 0;

        // UIDs of validated player accounts (Player Portal access) for the
        // active guild. A member gets the portal badge when their UID matches
        // an active member account of this guild.
        var portalUids = {};
        accounts.forEach(function (a) {
            if (a.role === 'member' && a.status === 'active' && a.uid) {
                portalUids[String(a.uid)] = true;
            }
        });

        var currentG = window.currentGuildRestriction || window.currentGuild || localStorage.getItem('gm_current_guild') || 'ALPHA';

        var filteredAdmin = guildMembers.filter(function (m) {
            var memberG = m.guild || 'ALPHA';
            var matchGuild = (memberG === currentG);
            var matchSearch = (m.pseudo.toLowerCase() + ' ' + (m.uid || '').toLowerCase()).indexOf(qAdmin) !== -1;
            var matchTier = (tAdmin === 'ALL') || (window.GM.getPowerTier(m.overall_power, maxPower) === tAdmin);
            return matchGuild && matchSearch && matchTier;
        });
        var filteredMember = guildMembers.filter(function (m) {
            var memberG = m.guild || 'ALPHA';
            var matchGuild = (memberG === currentG);
            var matchSearch = (m.pseudo.toLowerCase() + ' ' + (m.uid || '').toLowerCase()).indexOf(qMember) !== -1;
            var matchTier = (tMember === 'ALL') || (window.GM.getPowerTier(m.overall_power, maxPower) === tMember);
            return matchGuild && matchSearch && matchTier;
        });

        function sortMembers(list, sortVal) {
            return list.slice().sort(function (a, b) {
                if (sortVal === 'pseudo_asc') {
                    return a.pseudo.localeCompare(b.pseudo);
                } else if (sortVal === 'pseudo_desc') {
                    return b.pseudo.localeCompare(a.pseudo);
                } else if (sortVal === 'power_desc') {
                    var pA = parseInt(a.overall_power) || 0;
                    var pB = parseInt(b.overall_power) || 0;
                    return pB - pA;
                } else if (sortVal === 'power_asc') {
                    var pA = parseInt(a.overall_power) || 0;
                    var pB = parseInt(b.overall_power) || 0;
                    return pA - pB;
                }
                return 0;
            });
        }

        var roleNames = {
            'R5': 'R5 (Leader)',
            'R4': 'R4 (Officer)',
            'R3': 'R3 (Veteran)',
            'R2': 'R2 (Member)',
            'R1': 'R1 (Recruit)'
        };
        var roleOrder = ['R5', 'R4', 'R3', 'R2', 'R1'];

        function buildGroupedListHtml(filteredList, sortVal, withActions, portalUids) {
            // Group the filtered list
            var grouped = { R5: [], R4: [], R3: [], R2: [], R1: [] };
            filteredList.forEach(function (m) {
                var r = m.role || 'R1';
                if (!grouped[r]) grouped[r] = [];
                grouped[r].push(m);
            });

            var html = '<div class="gm-member-groups" style="display: flex; flex-direction: column; gap: 1rem; width: 100%;">';
            var hasAnyMembers = false;

            roleOrder.forEach(function (role) {
                var membersInRole = grouped[role];
                var sorted = sortMembers(membersInRole, sortVal);

                if (sorted.length > 0) {
                    hasAnyMembers = true;
                }

                var isCollapsed = !!window.GM_COLLAPSED_ROLES[role];
                var iconClass = isCollapsed ? 'ph-caret-right' : 'ph-caret-down';
                var displayStyle = isCollapsed ? 'none' : 'block';

                html += '<div class="gm-role-group" data-role="' + role + '">' +
                            '<div class="gm-role-group-header" data-role="' + role + '">' +
                                '<div class="gm-role-group-title">' +
                                    '<i class="ph ' + iconClass + ' gm-role-chevron"></i>' +
                                    '<span>' + esc(roleNames[role]) + '</span>' +
                                    '<span class="gm-role-count">' + sorted.length + '</span>' +
                                '</div>' +
                            '</div>' +
                            '<div class="gm-role-group-body" style="display: ' + displayStyle + ';">' +
                                (sorted.length 
                                    ? '<div class="gm-member-list">' + sorted.map(function (m, i) { return memberTileHtml(m, i, withActions, maxPower, portalUids); }).join('') + '</div>'
                                    : '<div class="gm-dim" style="font-size: 0.85rem; padding: 1rem; text-align: center;">No members in this role</div>') +
                            '</div>' +
                        '</div>';
            });

            html += '</div>';

            if (!hasAnyMembers) {
                return '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
            }
            return html;
        }

        if (guildMemberCount)  guildMemberCount.textContent  = filteredAdmin.length;
        if (guildMemberCountM) guildMemberCountM.textContent = filteredMember.length;

        if (guildMemberList) {
            guildMemberList.innerHTML = buildGroupedListHtml(filteredAdmin, sortAdmin, true, portalUids);
        }
        if (guildMemberListM) {
            guildMemberListM.innerHTML = buildGroupedListHtml(filteredMember, sortMember, false, portalUids);
        }

        // Attach collapse click listeners
        document.querySelectorAll('.gm-role-group-header').forEach(function (header) {
            header.addEventListener('click', function () {
                var role = header.getAttribute('data-role');
                window.GM_COLLAPSED_ROLES[role] = !window.GM_COLLAPSED_ROLES[role];
                renderGuildMembers();
            });
        });

        document.querySelectorAll('.guild-transfer-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var pseudo = btn.getAttribute('data-pseudo');
                var member = guildMembers.find(function (m) { return m.pseudo === pseudo; });
                if (member) showTransferMemberDialog(member);
            });
        });

        document.querySelectorAll('.guild-edit-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var pseudo = btn.getAttribute('data-pseudo');
                var member = guildMembers.find(function (m) { return m.pseudo === pseudo; });
                if (member) showEditMemberDialog(member);
            });
        });

        document.querySelectorAll('.guild-delete-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var pseudo = btn.getAttribute('data-pseudo');
                showConfirm(
                    t('confirm_remove_member_title'),
                    t('confirm_remove_member_body') + ' <strong>' + esc(pseudo) + '</strong> ' + t('confirm_remove_member_body2') +
                    '<br><span class="text-muted-sm">' + t('confirm_remove_member_cascade') + '</span>',
                    function () { deleteGuildMember(pseudo); }
                );
            });
        });
    }

    function memberTileHtml(m, i, withActions, maxPower, portalUids) {
        var lang = (window.GM_I18N && window.GM_I18N.getLang) ? window.GM_I18N.getLang() : 'en';
        var locale = lang === 'fr' ? 'fr-FR' : 'en-GB';
        var uidVal = m.uid || '-';
        var dateStr = m.created_at
            ? new Date(m.created_at).toLocaleDateString(locale, { day:'2-digit', month:'2-digit', year:'numeric' })
            : '-';
        var initial = window.GM.avatarInit(m.pseudo);

        var powerVal = parseInt(m.overall_power) || 0;
        var tier = window.GM.getPowerTier(powerVal, maxPower);
        var meta = window.GM.getPowerTierMeta(tier);
        var formattedPower = window.GM.formatPower(powerVal);

        var roleVal = m.role || 'R1';
        var roleStyles = {
            'R5': { text: 'R5', color: '#ffd166', bg: 'rgba(255,209,102,0.12)', border: 'rgba(255,209,102,0.3)', icon: '👑' },
            'R4': { text: 'R4', color: '#ffab76', bg: 'rgba(255,171,118,0.12)', border: 'rgba(255,171,118,0.3)', icon: '⚔️' },
            'R3': { text: 'R3', color: '#e4b5f0', bg: 'rgba(228,181,240,0.12)', border: 'rgba(228,181,240,0.3)', icon: '🛡️' },
            'R2': { text: 'R2', color: '#56c6f3', bg: 'rgba(86,198,243,0.12)', border: 'rgba(86,198,243,0.3)', icon: '👤' },
            'R1': { text: 'R1', color: '#6ee7b7', bg: 'rgba(110,231,183,0.12)', border: 'rgba(110,231,183,0.3)', icon: '🌱' }
        };
        var rMeta = roleStyles[roleVal] || roleStyles.R1;
        var roleBadgeHtml = '<span class="gm-role-chip" style="color:' + rMeta.color + '; border: 1px solid ' + rMeta.border + '; background:' + rMeta.bg + ';" title="Role ' + rMeta.text + '">' + rMeta.icon + ' ' + rMeta.text + '</span>';

        var tierBadge = '<span class="gm-power-tier-chip" style="color:' + meta.color + '; border: 1px solid ' + meta.color + '33; background: ' + meta.color + '12;" title="' + meta.label + ' Tier"><span>' + meta.icon + '</span> ' + formattedPower + '</span>';

        var absenceBadge = absenceBadgeHtml(m);
        var timezoneChip = timezoneChipHtml(m);

        var hasPortal = portalUids && uidVal !== '-' && !!portalUids[String(uidVal)];
        var portalBadge = hasPortal
            ? '<span class="gm-portal-chip" title="Player Portal account (validated)" style="color:#34d399; border:1px solid rgba(52,211,153,0.35); background:rgba(52,211,153,0.10); border-radius:999px; padding:0.05rem 0.35rem; font-size:0.68rem; display:inline-flex; align-items:center; gap:0.2rem;"><i class="ph ph-user-check"></i> Portal</span>'
            : '';

        return '<div class="gm-member-row" data-pseudo="' + esc(m.pseudo) + '">' +
                '<div class="gm-member-id">' +
                    '<div class="gm-avatar gm-avatar-squircle">' + esc(initial) + '</div>' +
                    '<div class="gm-grow gm-truncate">' +
                        '<div class="gm-member-pseudo-row">' +
                            '<span class="gm-member-pseudo">' + esc(m.pseudo) + '</span>' +
                            roleBadgeHtml +
                            portalBadge +
                            absenceBadge +
                            timezoneChip +
                        '</div>' +
                        '<div class="gm-member-sub-info">' +
                            '<span class="gm-mono gm-uid-text">UID ' + esc(uidVal) + '</span>' +
                            tierBadge +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="gm-member-date">' +
                    '<i class="ph ph-calendar-blank"></i> <span>' + dateStr + '</span>' +
                '</div>' +
                (withActions ? '<div class="gm-member-actions">' +
                    '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm guild-transfer-btn" data-pseudo="' + esc(m.pseudo) + '" data-uid="' + esc(uidVal) + '" title="Transfer member to another guild on same server" style="color: var(--accent);"><i class="ph ph-arrows-left-right"></i></button>' +
                    '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm guild-edit-btn" data-pseudo="' + esc(m.pseudo) + '" title="' + t('edit_title') + '"><i class="ph ph-pencil-simple"></i></button>' +
                    '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm guild-delete-btn" data-pseudo="' + esc(m.pseudo) + '" title="' + t('delete_title') + '" style="color: var(--danger);"><i class="ph ph-trash"></i></button>' +
                '</div>' : '') +
            '</div>';
    }

    // Absence badge for a member tile (active or upcoming declaration).
    function absenceBadgeHtml(m) {
        var absences = window.guildAbsences || [];
        if (absences.length === 0) return '';
        var now = new Date();
        var match = absences.find(function (a) {
            return a.uid === m.uid && new Date(a.end_date + 'T23:59:59') >= now;
        });
        if (!match) return '';
        var active = new Date(match.start_date + 'T00:00:00') <= now;
        var kindLabel = match.kind === 'reduced' ? 'Reduced activity' : 'Absent';
        var color = active ? '#f87171' : '#fbbf24';
        var bg = active ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.12)';
        var border = active ? 'rgba(248,113,113,0.35)' : 'rgba(251,191,36,0.35)';
        var range = esc(match.start_date) + ' → ' + esc(match.end_date);
        return '<span class="gm-absence-chip" style="color:' + color + '; border: 1px solid ' + border + '; background:' + bg + ';" title="' + kindLabel + ' ' + range + (match.note ? ' - ' + esc(match.note) : '') + '">' +
                    '<i class="ph ' + (active ? 'ph-user-minus' : 'ph-hourglass') + '"></i> ' + (active ? kindLabel : kindLabel + ' soon') +
                '</span>';
    }

    // Timezone chip on a member tile (declared by the player via the portal).
    function timezoneChipHtml(m) {
        var offset = m.timezone_offset;
        if (offset == null || isNaN(offset)) return '';
        var label = 'UTC' + (offset === 0 ? '' : (offset > 0 ? '+' + offset : offset));
        return '<span class="gm-tz-chip" title="Local timezone (declared by the player)">' +
                    '<i class="ph ph-clock"></i> ' + esc(label) +
                '</span>';
    }

    // Absence summary section: active/upcoming declarations visible to admins.
    function renderAbsenceSummary() {
        var section = document.getElementById('admin-absences-section');
        var listEl = document.getElementById('admin-absences-list');
        var countEl = document.getElementById('admin-absences-count');
        if (!section || !listEl || !countEl) return;

        var absences = window.guildAbsences || [];
        var now = new Date();
        var relevant = absences.filter(function (a) {
            return new Date(a.end_date + 'T23:59:59') >= now;
        });
        // Sort: active first, then by start date ascending
        relevant.sort(function (a, b) {
            var aActive = new Date(a.start_date + 'T00:00:00') <= now ? 0 : 1;
            var bActive = new Date(b.start_date + 'T00:00:00') <= now ? 0 : 1;
            if (aActive !== bActive) return aActive - bActive;
            return a.start_date.localeCompare(b.start_date);
        });

        if (relevant.length === 0) {
            section.style.display = 'none';
            return;
        }

        section.style.display = '';
        countEl.textContent = relevant.length;

        var membersByUid = {};
        guildMembers.forEach(function (m) { membersByUid[m.uid] = m; });

        var html = '<div class="gm-absence-grid">';
        relevant.forEach(function (a) {
            var member = membersByUid[a.uid];
            var start = new Date(a.start_date + 'T00:00:00');
            var end = new Date(a.end_date + 'T23:59:59');
            var active = start <= now;
            var kindLabel = a.kind === 'reduced' ? 'Reduced activity' : 'Full absence';
            var color = active ? '#f87171' : '#fbbf24';
            var bg = active ? 'rgba(248,113,113,0.10)' : 'rgba(251,191,36,0.10)';
            var border = active ? 'rgba(248,113,113,0.35)' : 'rgba(251,191,36,0.35)';

            html += '<div class="gm-absence-card">' +
                        '<div class="gm-absence-card-head">' +
                            '<div class="gm-avatar gm-avatar-sm" style="background:' + bg + '; color:' + color + ';">' + esc(window.GM.avatarInit(member ? member.pseudo : (a.pseudo || '?'))) + '</div>' +
                            '<div class="gm-grow">' +
                                '<div class="gm-absence-card-name">' + esc(member ? member.pseudo : (a.pseudo || a.uid)) + '</div>' +
                                '<div class="gm-absence-card-kind" style="color:' + color + ';">' + esc(kindLabel) + '</div>' +
                            '</div>' +
                            '<span class="gm-absence-card-status" style="color:' + color + '; border: 1px solid ' + border + '; background:' + bg + ';">' + (active ? 'Active' : 'Upcoming') + '</span>' +
                        '</div>' +
                        '<div class="gm-absence-card-dates"><i class="ph ph-calendar-dots"></i> ' + esc(a.start_date) + ' → ' + esc(a.end_date) + '</div>' +
                        (a.note ? '<div class="gm-absence-card-note">' + esc(a.note) + '</div>' : '') +
                    '</div>';
        });
        html += '</div>';
        listEl.innerHTML = html;
    }

    // Timezone coverage: histogram of the players' current local hour.
    function renderTimezoneCoverage() {
        var section = document.getElementById('admin-timezone-section');
        var listEl = document.getElementById('admin-timezone-list');
        var countEl = document.getElementById('admin-timezone-count');
        if (!section || !listEl || !countEl) return;

        var withTz = guildMembers.filter(function (m) {
            return m.timezone_offset != null && !isNaN(m.timezone_offset) && (m.guild || 'ALPHA') === (window.currentGuildRestriction || window.currentGuild || 'ALPHA');
        });
        if (withTz.length === 0) {
            section.style.display = 'none';
            return;
        }

        section.style.display = '';
        countEl.textContent = withTz.length + '/' + guildMembers.length;

        // Current local hour per player
        var nowUtcHours = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
        var buckets = {};
        withTz.forEach(function (m) {
            var localHour = Math.floor(((nowUtcHours + m.timezone_offset) % 24 + 24) % 24);
            if (!buckets[localHour]) buckets[localHour] = [];
            buckets[localHour].push(m);
        });

        var maxCount = 0;
        Object.keys(buckets).forEach(function (h) { if (buckets[h].length > maxCount) maxCount = buckets[h].length; });
        if (maxCount <= 0) maxCount = 1;

        var html = '<div class="gm-tz-histogram">';
        for (var h = 0; h < 24; h++) {
            var list = buckets[h] || [];
            var pct = Math.round((list.length / maxCount) * 100);
            var isPeak = list.length === maxCount && list.length > 0;
            var label = String(h).padStart(2, '0') + ':00';
            var names = list.map(function (m) { return m.pseudo; }).join(', ');
            html += '<div class="gm-tz-bar-row"' + (names ? ' title="' + esc(names) + '"' : '') + '>' +
                        '<span class="gm-tz-bar-label">' + label + '</span>' +
                        '<div class="gm-tz-bar-track"><div class="gm-tz-bar' + (isPeak ? ' gm-tz-bar-peak' : '') + '" style="width:' + pct + '%;"></div></div>' +
                        '<span class="gm-tz-bar-count">' + list.length + '</span>' +
                    '</div>';
        }
        html += '</div>';
        listEl.innerHTML = html;
    }

    async function showTransferMemberDialog(member) {
        var existing = document.getElementById('transfer-member-overlay');
        if (existing) existing.remove();

        var currentG = window.currentGuildRestriction || window.currentGuild || localStorage.getItem('gm_current_guild') || 'ALPHA';

        // Fetch up-to-date guilds list and server numbers
        // Merge DB data with localStorage fallback (DB may have null if save failed previously)
        var guildsData = {};
        try {
            var res = await supabase.from('guilds').select('id, server_number').order('id');
            if (res.data && res.data.length > 0) {
                res.data.forEach(function (g) {
                    // Prefer DB value, fallback to localStorage, fallback to window.guildsData
                    var dbVal = g.server_number || '';
                    var lsVal = localStorage.getItem('gm_server_number_' + g.id) || '';
                    var memVal = (window.guildsData && window.guildsData[g.id]) ? (window.guildsData[g.id].server_number || '') : '';
                    guildsData[g.id] = dbVal || lsVal || memVal;
                });
            }
        } catch (err) {
            console.error('Failed to fetch guilds for transfer', err);
        }

        // If guildsData is empty or all blank, fall back entirely to window.guildsData
        if (Object.keys(guildsData).length === 0 && window.guildsData) {
            Object.keys(window.guildsData).forEach(function (g) {
                guildsData[g] = window.guildsData[g].server_number || '';
            });
        }

        var currentServer = guildsData[currentG] || null;

        var sisterGuilds = [];
        if (currentServer) {
            Object.keys(guildsData).forEach(function (g) {
                if (g !== currentG && guildsData[g] && guildsData[g] === currentServer) {
                    sisterGuilds.push(g);
                }
            });
        }

        if (!currentServer || sisterGuilds.length === 0) {
            showToast('No other guild exists on Server #' + (currentServer || '????') + '. Set a server number in Super Admin > Subscription Management & Server Numbers.', 'warning');
            return;
        }

        var optionsHtml = sisterGuilds.map(function (g) {
            return '<option value="' + esc(g) + '">' + esc(g) + ' (Server #' + esc(currentServer) + ')</option>';
        }).join('');

        var html =
            '<div id="transfer-member-overlay" class="gm-modal-overlay">' +
                '<div class="gm-modal-card" style="max-width: 480px; width: 90%; position: relative;">' +
                    '<div class="gm-modal-header" style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 1rem;">' +
                        '<div style="display:flex; align-items:center; gap:0.5rem;">' +
                            '<i class="ph ph-arrows-left-right" style="font-size: 1.5rem; color: var(--accent);"></i>' +
                            '<h3 style="margin:0; font-size: 1.2rem;">Transfer Member</h3>' +
                        '</div>' +
                        '<button type="button" class="gm-mini-btn gm-close-modal"><i class="ph ph-x"></i></button>' +
                    '</div>' +
                    '<div class="gm-modal-body" style="display:flex; flex-direction:column; gap:1rem;">' +
                        '<div style="background: rgba(255,255,255,0.03); padding: 0.75rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);">' +
                            '<div><strong>Player:</strong> <span style="color: var(--accent); font-weight: 700;">' + esc(member.pseudo) + '</span> (UID: ' + esc(member.uid) + ')</div>' +
                            '<div style="font-size: 0.85rem; color: var(--text-dim); margin-top: 0.25rem;">Current Guild: <strong>' + esc(currentG) + '</strong> (Server #' + esc(currentServer) + ')</div>' +
                        '</div>' +
                        '<div class="gm-form-group">' +
                            '<label class="gm-label" style="font-size: 0.85rem; font-weight: 600; margin-bottom: 0.35rem; display:block;">Select Target Guild on Server #' + esc(currentServer) + ':</label>' +
                            '<select id="transfer-target-guild" class="gm-select gm-input">' +
                                optionsHtml +
                            '</select>' +
                        '</div>' +
                        '<div style="background: var(--info-soft); color: var(--info); padding: 0.75rem; border-radius: 6px; border: 1px solid var(--info-soft); font-size: 0.8rem; line-height: 1.4;">' +
                            '<i class="ph ph-info" style="margin-right: 4px;"></i>' +
                            'This player will disappear from ' + esc(currentG) + ' and join the target guild. All historical point logs, event records, and sanctions are kept for past activity tracking.' +
                        '</div>' +
                    '</div>' +
                    '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top: 1.5rem;">' +
                        '<button type="button" class="gm-btn gm-btn-ghost gm-close-modal">Cancel</button>' +
                        '<button type="button" id="confirm-transfer-btn" class="gm-btn gm-btn-primary">' +
                            '<i class="ph ph-arrows-left-right"></i>' +
                            '<span>Confirm Transfer</span>' +
                        '</button>' +
                    '</div>' +
                '</div>' +
            '</div>';

        document.body.insertAdjacentHTML('beforeend', html);
        var overlay = document.getElementById('transfer-member-overlay');
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        function closeModal() {
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 200);
        }

        overlay.querySelectorAll('.gm-close-modal').forEach(function (btn) {
            btn.addEventListener('click', closeModal);
        });
        overlay.addEventListener('click', function (ev) {
            if (ev.target === overlay) closeModal();
        });

        var confirmBtn = document.getElementById('confirm-transfer-btn');
        confirmBtn.addEventListener('click', async function () {
            var targetSelect = document.getElementById('transfer-target-guild');
            var targetGuild = targetSelect ? targetSelect.value : null;
            if (!targetGuild) return;

            confirmBtn.disabled = true;
            var span = confirmBtn.querySelector('span');
            if (span) span.textContent = 'Transferring...';

            try {
                var res = await supabase.rpc('transfer_guild_member', {
                    p_uid: member.uid,
                    p_target_guild: targetGuild,
                    p_pseudo: member.pseudo
                });

                if (res.error) throw res.error;
                var data = res.data;
                if (!data || !data.ok) {
                    throw new Error((data && data.error) ? data.error : 'transfer_failed');
                }

                closeModal();
                showToast(member.pseudo + ' transferred to ' + targetGuild + ' on Server #' + currentServer + '!', 'success');
                await fetchGuildMembers();
            } catch (err) {
                showToast('Error transferring member: ' + err.message, 'error');
                confirmBtn.disabled = false;
                if (span) span.textContent = 'Confirm Transfer';
            }
        });
    }

    async function showEditMemberDialog(member) {
        var existing = document.getElementById('edit-member-overlay');
        if (existing) existing.remove();

        var nameHistory = [];
        if (member.uid) {
            try {
                var res = await supabase.from('player_name_history').select('*').eq('uid', member.uid).order('changed_at', { ascending: false });
                if (!res.error) nameHistory = res.data || [];
            } catch (err) {
                console.error('Fetch name history failed', err);
            }
        }

        var overlay = document.createElement('div');
        overlay.id = 'edit-member-overlay';
        overlay.className = 'confirm-overlay';

        var historyHtml = '';
        if (nameHistory.length > 0) {
            historyHtml = '<div style="margin-top: 1rem; border-top: 1px solid var(--border-soft); padding-top: 1rem; text-align: left;">' +
                '<h4 style="margin: 0 0 0.5rem 0; font-size: 0.9rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.35rem;"><i class="ph ph-clock-counter-clockwise"></i> ' + t('Name History') + '</h4>' +
                '<div style="max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 0.35rem;">' +
                nameHistory.map(function (h) {
                    var date = new Date(h.changed_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
                    return '<div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; background: var(--bg-dim); border: 1px solid var(--border-soft); padding: 0.35rem 0.5rem; border-radius: var(--radius-sm);">' +
                        '<span><strong>' + esc(h.old_pseudo) + '</strong> ➔ <strong>' + esc(h.new_pseudo) + '</strong> <span class="gm-dim" style="font-size:0.75rem;">(' + date + ' by ' + esc(h.changed_by) + ')</span></span>' +
                        '<button type="button" class="delete-history-btn" data-id="' + h.id + '" style="background: none; border: none; color: var(--error); cursor: pointer; padding: 2px;"><i class="ph ph-trash"></i></button>' +
                        '</div>';
                }).join('') +
                '</div></div>';
        }

        overlay.innerHTML =
            '<div class="confirm-card glass-card" style="max-width: 480px; width: 95vw;">' +
                '<div class="confirm-icon"><i class="ph-fill ph-pencil-simple text-accent"></i></div>' +
                '<h3>' + t('edit_member_title') + '</h3>' +
                '<p>' + t('edit_member_body') + '</p>' +
                '<form id="edit-member-form" style="display:flex; flex-direction:column; gap: 1rem; margin-top: 1rem;">' +
                    '<div class="input-group">' +
                        '<label for="edit-pseudo">' + t('label_pseudo') + '</label>' +
                        '<div class="input-wrapper">' +
                            '<i class="ph ph-game-controller"></i>' +
                            '<input type="text" id="edit-pseudo" required value="' + esc(member.pseudo) + '">' +
                        '</div>' +
                    '</div>' +
                    '<div class="input-group">' +
                        '<label for="edit-uid">UID</label>' +
                        '<div class="input-wrapper">' +
                            '<i class="ph ph-identification-badge"></i>' +
                            '<input type="text" id="edit-uid" value="' + esc(member.uid || '') + '">' +
                        '</div>' +
                    '</div>' +
                    '<div style="display: flex; gap: 1rem;">' +
                        '<div class="input-group" style="flex: 1;">' +
                            '<label for="edit-power">Overall Power</label>' +
                            '<div class="input-wrapper">' +
                                '<i class="ph ph-sword"></i>' +
                                '<input type="number" id="edit-power" value="' + esc(member.overall_power || '') + '" placeholder="e.g. 80000000">' +
                            '</div>' +
                        '</div>' +
                        '<div class="input-group" style="flex: 1;">' +
                            '<label for="edit-role"><i class="ph ph-crown" style="vertical-align:middle;margin-right:0.3rem"></i>Role</label>' +
                            '<select id="edit-role" style="background: var(--bg-1); border: 1px solid var(--border-soft); color: var(--text-normal); font-family: var(--font-family-body); font-size: 0.88rem; width: 100%; border-radius: var(--radius-md); padding: 0.65rem 0.75rem;">' +
                                '<option value="R1"' + (member.role === 'R1' ? ' selected' : '') + '>R1</option>' +
                                '<option value="R2"' + (member.role === 'R2' ? ' selected' : '') + '>R2</option>' +
                                '<option value="R3"' + (member.role === 'R3' ? ' selected' : '') + '>R3</option>' +
                                '<option value="R4"' + (member.role === 'R4' ? ' selected' : '') + '>R4</option>' +
                                '<option value="R5"' + (member.role === 'R5' ? ' selected' : '') + '>R5</option>' +
                            '</select>' +
                        '</div>' +
                    '</div>' +
                    historyHtml +
                    '<div class="confirm-actions">' +
                        '<button type="button" id="edit-cancel" class="btn-ghost">' + t('confirm_cancel') + '</button>' +
                        '<button type="submit" class="primary-btn">' + t('confirm_ok') + '</button>' +
                    '</div>' +
                '</form>' +
            '</div>';

        document.body.appendChild(overlay);
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        function close() {
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 300);
        }

        document.getElementById('edit-cancel').addEventListener('click', close);
        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });

        overlay.querySelectorAll('.delete-history-btn').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                var id = btn.getAttribute('data-id');
                var res = await supabase.from('player_name_history').delete().eq('id', id);
                if (!res.error) {
                    btn.closest('div').remove();
                    showToast('History entry removed', 'success');
                } else {
                    showToast('Error removing history entry', 'error');
                }
            });
        });

        document.getElementById('edit-member-form').addEventListener('submit', async function (e) {
            e.preventDefault();
            var newPseudo = document.getElementById('edit-pseudo').value;
            var newUid    = document.getElementById('edit-uid').value;
            var newPower  = document.getElementById('edit-power').value;
            var newRole   = document.getElementById('edit-role').value;
            var ok = await renameGuildMember(member.pseudo, newPseudo, newUid, newPower, newRole);
            if (ok) close();
        });
    }

    // ─── Confirm Dialog ───────────────────────────────────────────────────────
    function showConfirm(title, message, onConfirm) {
        var existing = document.getElementById('confirm-overlay');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'confirm-overlay';
        overlay.className = 'confirm-overlay';
        overlay.innerHTML =
            '<div class="confirm-card glass-card">' +
                '<div class="confirm-icon"><i class="ph-fill ph-warning text-error"></i></div>' +
                '<h3>' + esc(title) + '</h3>' +
                '<p>' + message + '</p>' +
                '<div class="confirm-actions">' +
                    '<button id="confirm-cancel" class="btn-ghost">' + t('confirm_cancel') + '</button>' +
                    '<button id="confirm-ok" class="btn-danger">' + t('confirm_ok') + '</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        function close() {
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 300);
        }
        document.getElementById('confirm-cancel').addEventListener('click', close);
        document.getElementById('confirm-ok').addEventListener('click', function () { close(); onConfirm(); });
        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    }
    window.showConfirm = showConfirm;

    // ─── Toasts ───────────────────────────────────────────────────────────────
    function showToast(message, type) {
        type = type || 'info';
        var icons = { success: 'ph-check-circle', error: 'ph-warning-circle', info: 'ph-info' };
        var toast = document.createElement('div');
        toast.className = 'toast ' + type;

        // Safe DOM construction : aucun innerHTML utilisateur
        var icon = document.createElement('i');
        icon.className = 'ph-fill ' + (icons[type] || 'ph-info');
        var span = document.createElement('span');
        span.textContent = String(message);
        toast.appendChild(icon);
        toast.appendChild(document.createTextNode(' '));
        toast.appendChild(span);

        toastContainer.appendChild(toast);
        setTimeout(function () {
            toast.classList.add('fade-out');
            setTimeout(function () { toast.remove(); }, 300);
        }, 3500);
    }

    function reloadActiveView() {
        var activePanel = document.querySelector('.tab-panel.active');
        if (!activePanel) return;
        triggerTabDataLoad(activePanel.id);
    }

    window.addEventListener('rad-lang-change', function () {
        if (bannedListContainer && bannedPlayers.length > 0) {
            renderBannedPlayers();
        }
        if (guildMembers.length > 0) {
            renderGuildMembers();
        }
    });

    async function openCustomMsgModal(eventPrefix) {
        var existing = document.getElementById('custom-msg-modal');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'custom-msg-modal';
        overlay.className = 'confirm-overlay';

        var reminders = [];
        if (eventPrefix === 'armsrace' || eventPrefix === 'dtr' || eventPrefix === 'shadowfront') {
            reminders = [
                { key: 'reminder_30', label: '30 Minutes Reminder' },
                { key: 'reminder_5',  label: '5 Minutes Reminder' },
                { key: 'start',       label: 'Event Start' }
            ];
        } else if (eventPrefix === 'calamity') {
            reminders = [
                { key: 'reminder_10', label: '10 Minutes Reminder' }
            ];
        } else if (eventPrefix === 'gvg') {
            reminders = [
                { key: 'reminder', label: '5 Minutes Reminder' },
                { key: 'start',    label: 'Event Start' }
            ];
        } else if (eventPrefix === 'svs') {
            reminders = [
                { key: 'reminder_30_invasion', label: '30 Min Reminder (Invasion)' },
                { key: 'reminder_30_defense',  label: '30 Min Reminder (Defense)' },
                { key: 'reminder_5_invasion',  label: '5 Min Reminder (Invasion)' },
                { key: 'reminder_5_defense',   label: '5 Min Reminder (Defense)' },
                { key: 'start_invasion',       label: 'Event Start (Invasion)' },
                { key: 'start_defense',        label: 'Event Start (Defense)' },
                { key: 'garrison',             label: 'Garrison Reminder' }
            ];
        }

        var templates = {};
        for (var i = 0; i < reminders.length; i++) {
            var r = reminders[i];
            templates[r.key + '_content'] = await window.GM.config.get('tpl_' + eventPrefix + '_' + r.key + '_content') || '';
            templates[r.key + '_title'] = await window.GM.config.get('tpl_' + eventPrefix + '_' + r.key + '_title') || '';
            templates[r.key + '_desc'] = await window.GM.config.get('tpl_' + eventPrefix + '_' + r.key + '_desc') || '';
        }

        function getDefaultTpl(eventPrefix, key, field) {
            if (eventPrefix === 'armsrace' || eventPrefix === 'dtr' || eventPrefix === 'shadowfront') {
                var namePlaceholder = '{event_name}';
                if (key === 'reminder_30') {
                    if (field === 'content') return '⏰ **Reminder:** ' + namePlaceholder + ' starts in **30 minutes**! {guild_tag}';
                    if (field === 'title') return '⏰ Reminder: ' + namePlaceholder + ' starts in 30 minutes!';
                    if (field === 'desc') return 'Get ready, soldiers! Please log in and prepare for the event.';
                } else if (key === 'reminder_5') {
                    if (field === 'content') return '🚨 **Immediate Reminder:** ' + namePlaceholder + ' starts in **5 minutes**! Get ready! {guild_tag}';
                    if (field === 'title') return '🚨 Immediate Reminder: ' + namePlaceholder + ' starts in 5 minutes!';
                    if (field === 'desc') return 'Action time! Join your squad now!';
                } else if (key === 'start') {
                    if (field === 'content') return '⚔️ **Event Started:** ' + namePlaceholder + ' starts now! {guild_tag}';
                    if (field === 'title') return '⚔️ Event Started: ' + namePlaceholder + ' is active!';
                    if (field === 'desc') return 'Action time! Join your squad now!';
                }
            } else if (eventPrefix === 'calamity') {
                if (field === 'content') return '⏰ **Calamity Befalls: Round {round} starts in 10 minutes!**';
                if (field === 'title') return '⏰ Calamity Befalls - Round {round} (Reminder)';
                if (field === 'desc') return 'Prepare your squads! Calamity Befalls Round {round} starts in 10 minutes.';
            } else if (eventPrefix === 'gvg') {
                if (key === 'reminder') {
                    if (field === 'content') return '⏰ **GvG: {event_name}** starts in **5 minutes**! @everyone';
                    if (field === 'title') return '⏰ GvG - {event_name} (Reminder)';
                    if (field === 'desc') return 'Get ready! The {event_name} event starts in 5 minutes.';
                } else if (key === 'start') {
                    if (field === 'content') return '⚔️ **GvG: {event_name}** starts now! @everyone';
                    if (field === 'title') return '⚔️ GvG - {event_name}';
                    if (field === 'desc') return 'The {event_name} event is active. Join the battle now!';
                }
            } else if (eventPrefix === 'svs') {
                if (key === 'reminder_30_invasion') {
                    if (field === 'content') return '⏰ **SvS: Invasion starts in 30 minutes! Prepare to attack!** @everyone';
                    if (field === 'title') return '⏰ SvS: Invasion starts in 30 minutes';
                    if (field === 'desc') return 'We won the preparation! We are invading the enemy server...';
                } else if (key === 'reminder_30_defense') {
                    if (field === 'content') return '⏰ **SvS: Defense starts in 30 minutes! Protect yourself!** @everyone';
                    if (field === 'title') return '⏰ SvS: Defense starts in 30 minutes';
                    if (field === 'desc') return 'We are being invaded. Please put all your ships in garrison now...';
                } else if (key === 'reminder_5_invasion') {
                    if (field === 'content') return '🚨 **SvS: Invasion starts in 5 minutes! Join attack squads!** @everyone';
                    if (field === 'title') return '🚨 SvS: Invasion starts in 5 minutes!';
                    if (field === 'desc') return 'Portal opens in 5 minutes! Ready to jump and attack...';
                } else if (key === 'reminder_5_defense') {
                    if (field === 'content') return '🚨 **SvS: Defense starts in 5 minutes! Ready your squads!** @everyone';
                    if (field === 'title') return '🚨 SvS: Defense starts in 5 minutes!';
                    if (field === 'desc') return 'Invasion is imminent. Make sure your home assets are safe...';
                } else if (key === 'start_invasion') {
                    if (field === 'content') return '⚔️ **SvS: Invasion has started! Go attack!** @everyone';
                    if (field === 'title') return '⚔️ SvS: Invasion has started!';
                    if (field === 'desc') return 'The invasion portal is open! Jump to the enemy server...';
                } else if (key === 'start_defense') {
                    if (field === 'content') return '⚔️ **SvS: Blackhole Defense has started! Protect the server!** @everyone';
                    if (field === 'title') return '⚔️ SvS: Defense has started!';
                    if (field === 'desc') return 'Enemy forces are entering our server! Defend the Blackhole at all costs...';
                } else if (key === 'garrison') {
                    if (field === 'content') return '🛡️ **SvS: Garrison Reminder** - Don\'t forget to put your ships in garrison! @everyone';
                    if (field === 'title') return '🛡️ SvS: Garrison Reminder';
                    if (field === 'desc') return 'Put your ships in garrison to avoid being attacked while offline.';
                }
            }
            return '';
        }

        var titleMap = {
            armsrace: 'Arms Race',
            dtr: 'Defend Trade Route',
            shadowfront: 'Shadowfront',
            calamity: 'Calamity Befalls',
            gvg: 'GvG Saturday',
            svs: 'SvS PvP'
        };

        var esc = window.GM.escapeHTML;

        var html = 
            '<div class="gm-profile-card" style="max-width: 600px; gap: 1.25rem; align-items: stretch; text-align: left;">' +
                '<div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-soft); padding-bottom: 0.75rem;">' +
                    '<h3 style="font-family: var(--font-display); font-size: 1.2rem; margin: 0; display: flex; align-items: center; gap: 0.5rem; color: var(--fg);">' +
                        '<i class="ph ph-note-pencil" style="color: var(--accent);"></i> Personalization - ' + titleMap[eventPrefix] +
                    '</h3>' +
                    '<button type="button" class="gm-btn gm-btn-ghost gm-btn-icon" id="custom-msg-modal-close" style="padding: 0.25rem;"><i class="ph ph-x"></i></button>' +
                '</div>' +
                '<div style="font-size: 0.82rem; color: var(--fg-dim); background: rgba(99, 102, 241, 0.08); border: 1px solid rgba(99, 102, 241, 0.15); border-radius: 6px; padding: 0.65rem 0.8rem; line-height: 1.4;">' +
                    '<strong>Available variables:</strong> <code>{event_name}</code>, <code>{date}</code>, <code>{guild_tag}</code>' +
                    (eventPrefix === 'calamity' ? ', <code>{round}</code>' : '') +
                    '<br><span style="font-size: 0.75rem;">Leave blank to use the default message template.</span>' +
                '</div>' +
                '<div style="display: flex; flex-direction: column; gap: 1.5rem; max-height: 50vh; overflow-y: auto; padding-right: 0.25rem;">';

        for (var i = 0; i < reminders.length; i++) {
            var r = reminders[i];
            var defContent = getDefaultTpl(eventPrefix, r.key, 'content');
            var defTitle = getDefaultTpl(eventPrefix, r.key, 'title');
            var defDesc = getDefaultTpl(eventPrefix, r.key, 'desc');

            var valContent = templates[r.key + '_content'] || '';
            var valTitle = templates[r.key + '_title'] || '';
            var valDesc = templates[r.key + '_desc'] || '';

            html += 
                '<div style="display: flex; flex-direction: column; gap: 0.75rem; border-bottom: 1px dashed var(--border-soft); padding-bottom: 1.25rem;">' +
                    '<div style="font-size: 0.85rem; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: 0.04em;">' + r.label + '</div>' +
                    '<div class="gm-col" style="gap: 0.35rem;">' +
                        '<label style="font-size: 0.78rem; color: var(--fg-dim);">Discord Message (ping / main text):</label>' +
                        '<input type="text" id="tpl-' + r.key + '-content" class="gm-input gm-input-sm" style="font-size: 0.8rem;" placeholder="' + esc(defContent) + '" value="' + esc(valContent) + '">' +
                    '</div>' +
                    '<div class="gm-col" style="gap: 0.35rem;">' +
                        '<label style="font-size: 0.78rem; color: var(--fg-dim);">Embed Title:</label>' +
                        '<input type="text" id="tpl-' + r.key + '-title" class="gm-input gm-input-sm" style="font-size: 0.8rem;" placeholder="' + esc(defTitle) + '" value="' + esc(valTitle) + '">' +
                    '</div>' +
                    '<div class="gm-col" style="gap: 0.35rem;">' +
                        '<label style="font-size: 0.78rem; color: var(--fg-dim);">Embed Description:</label>' +
                        '<textarea id="tpl-' + r.key + '-desc" class="gm-input" style="font-size: 0.8rem; height: 60px; resize: vertical;" placeholder="' + esc(defDesc) + '">' + valDesc + '</textarea>' +
                    '</div>' +
                '</div>';
        }

        html += 
                '</div>' +
                '<div style="display: flex; gap: 0.75rem; justify-content: flex-end; border-top: 1px solid var(--border-soft); padding-top: 0.75rem;">' +
                    '<button type="button" class="gm-btn gm-btn-ghost" id="custom-msg-modal-cancel">Cancel</button>' +
                    '<button type="button" class="gm-btn gm-btn-primary" id="custom-msg-modal-save">' +
                        '<i class="ph ph-check"></i> Save' +
                    '</button>' +
                '</div>' +
            '</div>';

        overlay.innerHTML = html;
        document.body.appendChild(overlay);

        requestAnimationFrame(function () {
            overlay.classList.add('visible');
        });

        var closeModal = function () {
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 250);
        };

        document.getElementById('custom-msg-modal-close').addEventListener('click', closeModal);
        document.getElementById('custom-msg-modal-cancel').addEventListener('click', closeModal);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeModal();
        });

        var saveBtn = document.getElementById('custom-msg-modal-save');
        saveBtn.addEventListener('click', async function () {
            saveBtn.disabled = true;
            var span = saveBtn.querySelector('span') || saveBtn;
            var origText = span.innerHTML;
            span.textContent = '...';

            try {
                var promises = [];
                for (var i = 0; i < reminders.length; i++) {
                    var r = reminders[i];
                    var valContent = document.getElementById('tpl-' + r.key + '-content').value.trim();
                    var valTitle = document.getElementById('tpl-' + r.key + '-title').value.trim();
                    var valDesc = document.getElementById('tpl-' + r.key + '-desc').value.trim();

                    promises.push(window.GM.config.set('tpl_' + eventPrefix + '_' + r.key + '_content', valContent));
                    promises.push(window.GM.config.set('tpl_' + eventPrefix + '_' + r.key + '_title', valTitle));
                    promises.push(window.GM.config.set('tpl_' + eventPrefix + '_' + r.key + '_desc', valDesc));
                }
                await Promise.all(promises);
                showToast(t('toast_config_updated'), 'success');
                closeModal();
            } catch (err) {
                showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                saveBtn.disabled = false;
                span.innerHTML = origText;
            }
        });
    }

    document.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-custom-msg]');
        if (btn) {
            var eventPrefix = btn.getAttribute('data-custom-msg');
            openCustomMsgModal(eventPrefix);
        }
    });

    // ─── Player Portal ──────────────────────────────────────────────────────────
    var playerPortalView = document.getElementById('player-portal-view');
    var portalStepLookup = document.getElementById('portal-step-lookup');
    var portalStepForm   = document.getElementById('portal-step-form');
    var portalIdInput    = document.getElementById('portal-id');
    var portalPasswordInput = document.getElementById('portal-password');
    var portalLookupError = document.getElementById('portal-lookup-error');
    var portalLookupBtn  = document.getElementById('portal-lookup-btn');

    document.getElementById('go-to-portal-btn').addEventListener('click', function () {
        loginView.classList.add('hidden');
        playerPortalView.classList.remove('hidden');
        playerPortalView.classList.remove('portal-connected');
        portalStepLookup.classList.remove('hidden');
        portalStepForm.classList.add('hidden');
        portalLookupError.classList.add('hidden');
        portalIdInput.value = '';
        portalPasswordInput.value = '';
        var portalContainer = document.querySelector('.gm-portal-container');
        if (portalContainer) portalContainer.classList.remove('portal-wide');
    });

    document.getElementById('portal-go-register-btn').addEventListener('click', function () {
        playerPortalView.classList.add('hidden');
        playerPortalView.classList.remove('portal-connected');
        loginView.classList.remove('hidden');
        showRegisterForm(true);
        var portalContainer = document.querySelector('.gm-portal-container');
        if (portalContainer) portalContainer.classList.remove('portal-wide');
    });

    document.querySelectorAll('.portal-back-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            // Sign out of the portal session so the next player signs in with their own account
            localStorage.removeItem('gm_portal_session');
            playerPortalView.classList.remove('portal-connected');
            var portalContainer = document.querySelector('.gm-portal-container');
            if (portalContainer) portalContainer.classList.remove('portal-wide');
            window.GM.logout().then(function () {
                playerPortalView.classList.add('hidden');
                loginView.classList.remove('hidden');
            }).catch(function () {
                playerPortalView.classList.add('hidden');
                loginView.classList.remove('hidden');
            });
        });
    });

    portalLookupBtn.addEventListener('click', async function () {
        var id = portalIdInput.value.trim();
        var pass = portalPasswordInput.value;
        if (!id || !pass) return;

        portalLookupBtn.disabled = true;
        var span = portalLookupBtn.querySelector('span');
        var origText = span ? span.textContent : '';
        if (span) span.textContent = 'Signing in...';
        portalLookupError.classList.add('hidden');

        try {
            var loginResp = await window.GM.login(id, pass);
            if (!loginResp.ok) {
                portalLookupError.querySelector('span').textContent =
                    loginResp.error === 'pending_approval'
                        ? 'Your account is awaiting approval by a guild admin.'
                        : 'Invalid identifier or password.';
                portalLookupError.classList.remove('hidden');
                return;
            }

            // Mark this session as a player-portal session so a page refresh
            // restores the portal instead of the admin dashboard.
            localStorage.setItem('gm_portal_session', '1');
            localStorage.setItem('gm_role', 'member');
            localStorage.setItem('gm_user', id);

            var { data, error } = await supabase.functions.invoke('member-portal', {
                body: { action: 'get-active-sessions', payload: {} }
            });

            if (error || !data || !data.ok) {
                portalLookupError.querySelector('span').textContent = 'Unable to connect to the portal. Please try again.';
                portalLookupError.classList.remove('hidden');
                return;
            }

            if (data.error === 'player_not_found') {
                portalLookupError.querySelector('span').textContent = 'Your account is not linked to a guild member.';
                portalLookupError.classList.remove('hidden');
                return;
            }

            // Successfully fetched data
            portalStepLookup.classList.add('hidden');
            portalStepForm.classList.remove('hidden');
            playerPortalView.classList.add('portal-connected');
            var portalContainer = document.querySelector('.gm-portal-container');
            if (portalContainer) portalContainer.classList.add('portal-wide');
            if (window.GM_PORTAL) {
                window.GM_PORTAL.loadDashboard();
            } else {
                portalLookupError.querySelector('span').textContent = 'Portal module not loaded. Please reload the page.';
                portalLookupError.classList.remove('hidden');
            }
        } catch (err) {
            console.error(err);
            portalLookupError.querySelector('span').textContent = 'An error occurred during verification.';
            portalLookupError.classList.remove('hidden');
        } finally {
            portalLookupBtn.disabled = false;
            if (span) span.textContent = origText;
        }
    });

    window.GM_APP = window.GM_APP || {};
    window.GM_APP.showToast = showToast;
    window.GM_APP.reloadActiveView = reloadActiveView;

})();
