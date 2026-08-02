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

        // Restauration synchrone immédiate pour éviter le flash de l'écran de connexion
        if (localRole && !portalSession) {
            showAdminDashboard(localRole);
        }

        var info = await window.GM.sessionInfo();
        if (!info && portalSession) {
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
                var { data } = await supabase.from('accounts').select('guild').eq('id', info.accountId).maybeSingle();
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

        // Fetch guilds list (now authenticated, query will succeed)
        await fetchGuilds();

        // Always update the dashboard and shell to reflect fresh authenticated data
        showAdminDashboard(role);
        if (window.GM_SHELL && window.GM_SHELL.renderShell) {
            window.GM_SHELL.renderShell();
        }
        reloadActiveView();
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
                loginError.classList.add('hidden');
                document.getElementById('password').value = '';

                // Fetch guilds list
                await fetchGuilds();

                // Fetch guild restriction for new logins if guild_admin
                if (window.GM.normalizeRole(resp.role) === 'guild_admin') {
                    try {
                        var { data } = await supabase.from('accounts').select('guild').eq('id', user).maybeSingle();
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
                localStorage.setItem('gm_user', user);
                // Store in memory for reliable access
                window.GM.currentAccountId = user;

                showAdminDashboard(role);
                if (window.GM_SHELL && window.GM_SHELL.renderShell) {
                    window.GM_SHELL.renderShell();
                }
                showToast(role === 'super_admin' ? t('toast_login_ok') : (t('toast_welcome') + ' ' + user + ' !'), 'success');
            } else if (resp.error === 'pending_approval') {
                loginError.classList.remove('hidden');
                var pe = loginError.querySelector('span');
                if (pe) pe.textContent = 'Your account is awaiting approval by a guild admin.';
            } else {
                throw new Error('invalid');
            }
        } catch (err) {
            console.error('Login error details:', err);
            loginError.classList.remove('hidden');
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
        var chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+';
        var values = new Uint32Array(length);
        crypto.getRandomValues(values);
        return Array.from(values, function(v) { return chars[v % chars.length]; }).join('');
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
            var res = await supabase.from('guilds').select('id, subscription_type, subscription_end, server_number').order('id');
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
                        server_number: sNum
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
            selectR4.innerHTML = '<option value="' + myGuild + '">' + myGuild + '</option>';
            selectR4.value = myGuild;
            selectR4.disabled = true;
        }

        var selectR5 = document.getElementById('superadmin-account-guild');
        if (selectR5) {
            var html = '';
            (window.guildsList || ['ALPHA', 'OMEGA', 'IMK']).forEach(function (g) {
                var sNum = (window.guildsData && window.guildsData[g] && window.guildsData[g].server_number) ? ' (#' + window.guildsData[g].server_number + ')' : '';
                html += '<option value="' + g + '">' + g + sNum + '</option>';
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

        var showCalamityGvgSvs = (window.currentGuild !== 'OMEGA' && window.currentGuild !== 'IMK');
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
                var showCalamityGvgSvs = (window.currentGuild !== 'OMEGA' && window.currentGuild !== 'IMK');
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

    function renderPendingRegistrations(activeG) {
        var container = document.getElementById('pending-account-list');
        var countEl = document.getElementById('pending-account-count');
        if (!container) return;

        var pending = accounts.filter(function (acc) {
            return acc.status === 'pending' && acc.role === 'member' &&
                   (acc.guild || 'ALPHA') === activeG;
        });
        if (countEl) countEl.textContent = pending.length;

        if (pending.length === 0) {
            container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-hourglass gm-icon"></i><div class="gm-empty-title">No pending registrations</div></div>';
            return;
        }

        var html = '<div class="gm-cred-grid">';
        pending.forEach(function (acc) {
            var dateStr = acc.created_at ? new Date(acc.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
            html +=
                '<div class="gm-cred-card" data-acc-id="' + esc(acc.id) + '">' +
                    '<div class="gm-row" style="justify-content:space-between; margin-bottom: 0.25rem;">' +
                        '<div class="gm-cred-name">' + esc(acc.id) + '</div>' +
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

    async function resolveRegistration(id, action) {
        try {
            var res = await window.GM.adminAccounts(action === 'approve' ? 'approve-registration' : 'reject-registration', { id: id });
            if (!res.ok) throw new Error(res.error || (action + '_failed'));
            accounts = accounts.filter(function (a) { return a.id !== id; });
            renderAccounts();
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
        var generateBtn = document.getElementById('join-code-generate-btn');
        var copyBtn = document.getElementById('join-code-copy-btn');
        var resultBox = document.getElementById('join-code-result');
        var resultVal = document.getElementById('join-code-value');
        var infoEl = document.getElementById('join-code-info');
        if (!generateBtn) return;

        var hasCode = false;
        var storedCode = '';
        try { storedCode = localStorage.getItem(joinCodeStorageKey()) || ''; } catch (_) {}

        (window.GM.config.get('join_code_hash')).then(function (hash) {
            hasCode = !!hash;
            var label = document.getElementById('join-code-btn-label');
            if (label) label.textContent = hasCode ? 'Regenerate Code' : 'Generate Code';
            if (infoEl) {
                if (storedCode) {
                    infoEl.textContent = 'Share this code with your players. Anyone with it can register.';
                } else if (hasCode) {
                    infoEl.textContent = 'A join code is already set but was generated elsewhere. Regenerate to get a new one.';
                } else {
                    infoEl.textContent = 'No join code set yet. Players cannot register until you generate one.';
                }
            }
            // Re-show the stored code so admins never lose it
            if (storedCode && resultVal) resultVal.textContent = storedCode;
            if (storedCode && resultBox) resultBox.classList.remove('hidden');
            if (storedCode && copyBtn) copyBtn.classList.remove('hidden');
        }).catch(function () {});

        generateBtn.addEventListener('click', async function () {
            var generatedCode = window.GM.generateJoinCode('FGF');
            generateBtn.disabled = true;
            var span = generateBtn.querySelector('span');
            if (span) span.textContent = 'Saving...';
            try {
                var res = await window.GM.adminAccounts('set-join-code', {
                    code: generatedCode,
                    guild: window.currentGuild || window.GM.getActiveGuild() || 'ALPHA'
                });
                if (!res.ok) throw new Error(res.error || 'set_code_failed');
                // Persist the plain code for this guild
                try { localStorage.setItem(joinCodeStorageKey(), generatedCode); } catch (_) {}
                storedCode = generatedCode;
                if (resultVal) resultVal.textContent = generatedCode;
                if (resultBox) resultBox.classList.remove('hidden');
                if (copyBtn) copyBtn.classList.remove('hidden');
                if (infoEl) infoEl.textContent = 'Share this code with your players. Anyone with it can register.';
                showToast('Join code generated.', 'success');
            } catch (err) {
                showToast(t('toast_err_generic') + ' ' + err.message, 'error');
            } finally {
                generateBtn.disabled = false;
                if (span) span.textContent = hasCode ? 'Regenerate Code' : 'Generate Code';
            }
        });

        if (copyBtn) copyBtn.addEventListener('click', function () {
            var code = storedCode || (resultVal ? resultVal.textContent : '') || '';
            if (!code) return;
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

        // Target 1: Admin Section (#account-list) - accounts for current active guild only
        var containerR4 = document.getElementById('account-list');
        var countR4 = document.getElementById('account-count');
        if (containerR4) {
            var listR4 = accounts.filter(function (acc) {
                if (acc.status === 'pending') return false;
                var accGuild = acc.guild || 'ALPHA';
                var isR5 = (acc.role === 'super_admin');
                // Super Admin account ONLY shown when activeG is ALPHA
                if (isR5) {
                    return true;
                }
                return accGuild === activeG;
            });
            renderAccountCardsToContainer(containerR4, countR4, listR4, isSuperAdminUser);
        }

        // Target 2: Super Admin Section (#superadmin-account-list) - all R4 admin accounts across guilds
        var containerR5 = document.getElementById('superadmin-account-list');
        var countR5 = document.getElementById('superadmin-account-count');
        if (containerR5) {
            var listR5 = accounts.filter(function (acc) {
                return acc.role !== 'super_admin';
            });
            listR5.sort(function (a, b) {
                var gA = a.guild || '';
                var gB = b.guild || '';
                if (gA !== gB) return gA.localeCompare(gB);
                return a.id.localeCompare(b.id);
            });
            renderAccountCardsToContainer(containerR5, countR5, listR5, isSuperAdminUser);
        }
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
            var roleLabel = role === 'super_admin' ? 'Super Admin' : 'Admin';
            var chipCls = role === 'super_admin' ? 'gm-chip-accent' : 'gm-chip-info';
            var dateStr = acc.created_at ? new Date(acc.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' }) : '—';
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
                // FIX (C4): No longer storing password in data-acc-pass DOM attribute.
                // Passwords are fetched on demand from the API when eye/copy is clicked.
                passHtml = '<div class="gm-cred-pass gm-masked" data-acc-id="' + esc(acc.id) + '">' +
                               '<span class="gm-pwd-text">••••••••••••</span>' +
                               '<button class="gm-mini-btn gm-cred-toggle" title="' + t('show_pwd') + '"><i class="ph ph-eye"></i></button>' +
                               '<button class="gm-mini-btn gm-cred-copy" title="' + t('copy_title') + '"><i class="ph ph-copy"></i></button>' +
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
                (window.guildsList || ['ALPHA', 'OMEGA', 'IMK']).forEach(function (g) {
                    options += '<option value="' + g + '"' + (acc.guild === g ? ' selected' : '') + '>' + g + '</option>';
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

        // FIX (C4): Passwords are no longer stored in data-acc-pass DOM attributes.
        // On reveal/copy, we check the in-memory pendingPasswords cache first (freshly created accounts),
        // then fall back to calling the get-password API endpoint.
        container.querySelectorAll('.gm-cred-toggle').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                var wrap = btn.closest('.gm-cred-pass');
                var accId = wrap.getAttribute('data-acc-id');
                var pwdSpan = wrap.querySelector('.gm-pwd-text');
                var icon = btn.querySelector('i');
                if (wrap.classList.contains('gm-masked')) {
                    var pass = pendingPasswords[accId] || wrap.getAttribute('data-acc-pass-temp');
                    if (!pass) {
                        btn.disabled = true;
                        try {
                            var res = await window.GM.adminAccounts('get-password', { id: accId });
                            if (!res.ok) throw new Error(res.error || 'fetch_failed');
                            pass = res.password;
                        } catch (err) {
                            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                            btn.disabled = false;
                            return;
                        }
                        btn.disabled = false;
                    }
                    wrap.setAttribute('data-acc-pass-temp', pass);
                    wrap.classList.remove('gm-masked');
                    pwdSpan.textContent = pass;
                    icon.className = 'ph ph-eye-slash';
                } else {
                    wrap.classList.add('gm-masked');
                    wrap.removeAttribute('data-acc-pass-temp');
                    pwdSpan.textContent = '••••••••••••';
                    icon.className = 'ph ph-eye';
                }
            });
        });

        container.querySelectorAll('.gm-cred-copy').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                var wrap = btn.closest('.gm-cred-pass');
                var accId = wrap.getAttribute('data-acc-id');
                var pass = pendingPasswords[accId] || wrap.getAttribute('data-acc-pass-temp');
                if (!pass) {
                    btn.disabled = true;
                    try {
                        var res = await window.GM.adminAccounts('get-password', { id: accId });
                        if (!res.ok) throw new Error(res.error || 'fetch_failed');
                        pass = res.password;
                    } catch (err) {
                        showToast(t('toast_err_generic') + ' ' + err.message, 'error');
                        btn.disabled = false;
                        return;
                    }
                    btn.disabled = false;
                }
                navigator.clipboard.writeText(pass).then(function () {
                    var icon = btn.querySelector('i');
                    icon.className = 'ph ph-check';
                    showToast(t('toast_copied'), 'success');
                    setTimeout(function () { icon.className = 'ph ph-copy'; }, 2000);
                });
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

            var html = '<div class="gm-cred-grid">';
            guildsListRaw.forEach(function (g) {
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
                        '</div>' +
                    '</div>';
            });
            html += '</div>';
            container.innerHTML = html;

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

        } catch (err) {
            container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-warning-octagon gm-icon" style="color:var(--danger);"></i><div class="gm-empty-title">Error: ' + esc(err.message) + '</div></div>';
        }
    }

    // ─── Guild Members & Transfers ──────────────────────────────────────────
    var pendingTransfers = [];

    async function fetchGuildMembers() {
        if (!supabase) return;
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        try {
            var [res, transfersRes, absencesRes] = await Promise.all([
                supabase.from('guild_members').select('*').order('pseudo', { ascending: true }),
                supabase.from('guild_transfers').select('id, uid, pseudo, source_guild').eq('target_guild', currentG).eq('status', 'pending').order('created_at', { ascending: true }),
                supabase.from('player_absences').select('*').eq('guild', currentG)
            ]);
            
            if (res.error) throw res.error;
            guildMembers = res.data || [];
            
            if (!transfersRes.error) {
                pendingTransfers = transfersRes.data || [];
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

        var html = '';
        pendingTransfers.forEach(function (t) {
            html += '<tr>' +
                '<td data-label="Player"><div class="gm-member-name"><div class="gm-avatar gm-avatar-sm gm-avatar-info">' + esc(window.GM.avatarInit(t.pseudo)) + '</div>' + esc(t.pseudo) + '</div></td>' +
                '<td data-label="UID"><div class="gm-uid-badge">' + esc(t.uid) + '</div></td>' +
                '<td data-label="Source Guild">' + esc(t.source_guild) + '</td>' +
                '<td class="gm-center" data-label="Actions" style="white-space: nowrap;">' +
                    '<button type="button" class="gm-btn gm-btn-sm gm-btn-success" onclick="window.GM.resolveTransfer(\'' + t.id + '\', \'approve\')" style="margin-right: 0.25rem;" title="Approve Transfer"><i class="ph ph-check"></i></button>' +
                    '<button type="button" class="gm-btn gm-btn-sm gm-btn-danger" onclick="window.GM.resolveTransfer(\'' + t.id + '\', \'reject\')" title="Reject Transfer"><i class="ph ph-x"></i></button>' +
                '</td>' +
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
                showToast('Player ID is already in use by another guild. Use Transfer instead.', 'error');
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
            if (window.GM_EVENTS && window.GM_EVENTS.addMemberToActiveEvents) {
                addedEvents += await window.GM_EVENTS.addMemberToActiveEvents(pseudo);
            }
            if (window.GM_ARMSRACE && window.GM_ARMSRACE.addMemberToActiveEvents) {
                addedEvents += await window.GM_ARMSRACE.addMemberToActiveEvents(pseudo);
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
                : '—';
            var pseudoVal = bp.pseudo || '—';
            var reasonVal = bp.reason || '—';
            var author = bp.created_by || '—';
            var initial = window.GM.avatarInit(pseudoVal !== '—' ? pseudoVal : fallbackName);
            
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

        function buildGroupedListHtml(filteredList, sortVal, withActions) {
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
                                    ? '<div class="gm-member-list">' + sorted.map(function (m, i) { return memberTileHtml(m, i, withActions, maxPower); }).join('') + '</div>'
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
            guildMemberList.innerHTML = buildGroupedListHtml(filteredAdmin, sortAdmin, true);
        }
        if (guildMemberListM) {
            guildMemberListM.innerHTML = buildGroupedListHtml(filteredMember, sortMember, false);
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

    function memberTileHtml(m, i, withActions, maxPower) {
        var lang = (window.GM_I18N && window.GM_I18N.getLang) ? window.GM_I18N.getLang() : 'en';
        var locale = lang === 'fr' ? 'fr-FR' : 'en-GB';
        var uidVal = m.uid || '—';
        var dateStr = m.created_at
            ? new Date(m.created_at).toLocaleDateString(locale, { day:'2-digit', month:'2-digit', year:'numeric' })
            : '—';
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

        return '<div class="gm-member-row" data-pseudo="' + esc(m.pseudo) + '">' +
                '<div class="gm-member-id">' +
                    '<div class="gm-avatar gm-avatar-squircle">' + esc(initial) + '</div>' +
                    '<div class="gm-grow gm-truncate">' +
                        '<div class="gm-member-pseudo-row">' +
                            '<span class="gm-member-pseudo">' + esc(m.pseudo) + '</span>' +
                            roleBadgeHtml +
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
        return '<span class="gm-absence-chip" style="color:' + color + '; border: 1px solid ' + border + '; background:' + bg + ';" title="' + kindLabel + ' ' + range + (match.note ? ' — ' + esc(match.note) : '') + '">' +
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
                    p_target_guild: targetGuild
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
                    var date = new Date(h.changed_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
                    return '<div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; background: var(--bg-dim); border: 1px solid var(--border-soft); padding: 0.35rem 0.5rem; border-radius: var(--radius-sm);">' +
                        '<span><strong>' + esc(h.old_pseudo) + '</strong> ➔ <strong>' + esc(h.new_pseudo) + '</strong> <span class="gm-dim" style="font-size:0.75rem;">(' + date + ' par ' + esc(h.changed_by) + ')</span></span>' +
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
                            '<label for="edit-role">Role</label>' +
                            '<div class="input-wrapper">' +
                                '<i class="ph ph-crown"></i>' +
                                '<select id="edit-role" style="background: var(--bg-1); border: 1px solid var(--border-soft); color: var(--text-normal); font-family: var(--font-family-body); font-size: 0.88rem; width: 100%; border-radius: var(--radius-md); padding: 0.65rem 0.5rem;">' +
                                    '<option value="R1"' + (member.role === 'R1' ? ' selected' : '') + '>R1</option>' +
                                    '<option value="R2"' + (member.role === 'R2' ? ' selected' : '') + '>R2</option>' +
                                    '<option value="R3"' + (member.role === 'R3' ? ' selected' : '') + '>R3</option>' +
                                    '<option value="R4"' + (member.role === 'R4' ? ' selected' : '') + '>R4</option>' +
                                    '<option value="R5"' + (member.role === 'R5' ? ' selected' : '') + '>R5</option>' +
                                '</select>' +
                            '</div>' +
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
