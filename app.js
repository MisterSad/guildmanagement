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
    var addBannedForm     = document.getElementById('add-banned-form');
    var bannedListContainer = document.getElementById('banned-list-container');
    var bannedCount       = document.getElementById('banned-count');
    var bannedSearch      = document.getElementById('banned-search');

    // ─── State ────────────────────────────────────────────────────────────────
    var accounts      = [];
    var guildMembers  = [];
    var bannedPlayers = [];
    window.GM_COLLAPSED_ROLES = { R5: false, R4: false, R3: false, R2: false, R1: false };
    window.adminSelectedMembers = window.adminSelectedMembers || new Set();

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

        // Fetch guild or server restriction
        if (info.role === 'guild_admin' && info.accountId) {
            try {
                var { data } = await supabase.from('accounts').select('guild').ilike('id', info.accountId).maybeSingle();
                if (data && data.guild) {
                    window.currentGuildRestriction = data.guild;
                    window.currentGuild = data.guild;
                    localStorage.setItem('gm_current_guild', data.guild);
                    localStorage.setItem('gm_guild_restriction', data.guild);
                    localStorage.removeItem('gm_server_restriction');
                } else {
                    window.currentGuildRestriction = null;
                    localStorage.removeItem('gm_guild_restriction');
                    localStorage.removeItem('gm_server_restriction');
                }
            } catch (err) {
                console.error('Failed to restore account guild restriction:', err);
                window.currentGuildRestriction = null;
                localStorage.removeItem('gm_guild_restriction');
                localStorage.removeItem('gm_server_restriction');
            }
        } else if (info.role === 'server_admin' && info.accountId) {
            try {
                var { data } = await supabase.from('accounts').select('guild, server_number').ilike('id', info.accountId).maybeSingle();
                var sNum = data && data.server_number;
                if (!sNum && data && data.guild) {
                    var { data: g } = await supabase.from('guilds').select('server_number').eq('id', data.guild).maybeSingle();
                    if (g && g.server_number) sNum = g.server_number;
                }
                if (sNum) {
                    localStorage.setItem('gm_server_restriction', sNum);
                } else {
                    localStorage.removeItem('gm_server_restriction');
                }
                window.currentGuildRestriction = null;
                localStorage.removeItem('gm_guild_restriction');
            } catch (err) {
                console.error('Failed to restore server restriction:', err);
                window.currentGuildRestriction = null;
                localStorage.removeItem('gm_guild_restriction');
                localStorage.removeItem('gm_server_restriction');
            }
        } else {
            window.currentGuildRestriction = null;
            localStorage.removeItem('gm_guild_restriction');
            localStorage.removeItem('gm_server_restriction');
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
        if (role !== 'member' && window.GM_LEADER_HALL && window.GM_LEADER_HALL.initGlobalUnreadListener) {
            window.GM_LEADER_HALL.initGlobalUnreadListener();
        }
        reloadActiveView();

        // Handle a Stripe checkout redirect (back from the hosted payment
        // page): switch to the Donation tab in Player Portal or Command Center.
        var urlParams = new URLSearchParams(window.location.search);
        var checkoutMode = urlParams.get('checkout');
        if (checkoutMode === 'success' || checkoutMode === 'cancel') {
            var isPortalSession = role === 'member' || localStorage.getItem('gm_portal_session') === '1';
            if (isPortalSession) {
                setTimeout(function () {
                    var donationNav = document.querySelector('[data-portal-nav="donation"]');
                    if (donationNav) donationNav.click();
                    if (checkoutMode === 'success') {
                        var panel = document.getElementById('portal-panel-donation');
                        if (panel) {
                            panel.innerHTML =
                                '<div class="portal-card" style="text-align:center; padding:3rem 1.5rem; max-width:540px; margin:2rem auto;">' +
                                    '<div style="width:64px; height:64px; border-radius:50%; background:var(--accent-soft, rgba(99,102,241,0.15)); color:var(--accent, #6366f1); display:flex; align-items:center; justify-content:center; font-size:2rem; margin:0 auto 1.25rem auto;">' +
                                        '<i class="ph-fill ph-coffee"></i>' +
                                    '</div>' +
                                    '<h2 style="font-size:1.4rem; font-weight:800; color:var(--fg); margin:0 0 0.5rem 0;">Thank you for your support!</h2>' +
                                    '<p class="gm-dim" style="font-size:.92rem; line-height:1.6; margin:0 0 1.5rem 0;">Your donation helps keep the servers running and the AI scans available for everyone.</p>' +
                                    '<button class="gm-btn gm-btn-primary" data-back-to-donations><i class="ph ph-arrow-left"></i> Back to Donations</button>' +
                                '</div>';
                            var backBtn = panel.querySelector('[data-back-to-donations]');
                            if (backBtn) backBtn.addEventListener('click', function () {
                                if (window.GM_PORTAL && window.GM_PORTAL.renderDashboard) {
                                    var nav = document.querySelector('[data-portal-nav="donation"]');
                                    if (nav) nav.click();
                                }
                            });
                        }
                    }
                }, 300);
            } else {
                if (window.GM_SUBSCRIPTION && window.GM_SHELL && window.GM_SHELL.gotoItem) {
                    window.GM_SHELL.gotoItem('subscription');
                }
            }
            try {
                window.history.replaceState({}, '', window.location.pathname + window.location.hash);
            } catch (e) { /* non fatal */ }
        }
    })();

    // ─── Auth ─────────────────────────────────────────────────────────────────
    // A light nudge after a plain password login for an account with no
    // passkey yet — never after a passkey/backup-code login (hasPasskey is
    // already true there), and only once per browser session so it doesn't
    // nag on every login.
    function maybeShowSecureAccountPrompt(resp, role) {
        if (resp.hasPasskey !== false) return;
        if (sessionStorage.getItem('gm_secure_prompt_dismissed') === '1') return;
        if (!window.GM.webauthn || !window.GM.webauthn.isSupported()) return;

        var existing = document.getElementById('secure-account-banner');
        if (existing) existing.remove();

        var isPortal = (role === 'member');

        var banner = document.createElement('div');
        banner.id = 'secure-account-banner';
        banner.style.cssText = 'position:fixed; bottom:1rem; right:1rem; z-index:9000; max-width:360px; ' +
            'background:var(--bg-soft, #1a1a24); border:1px solid rgba(255,255,255,0.1); border-radius:12px; ' +
            'padding:1rem 1.1rem; box-shadow:0 8px 24px rgba(0,0,0,0.4); display:flex; flex-direction:column; gap:.6rem;';
        banner.innerHTML =
            '<div style="display:flex; align-items:flex-start; gap:.6rem;">' +
                '<i class="ph ph-fingerprint" style="font-size:1.4rem; color:var(--accent); flex-shrink:0; margin-top:.1rem;"></i>' +
                '<div>' +
                    '<div style="font-weight:600; margin-bottom:.15rem;">Secure your account</div>' +
                    '<div style="font-size:.82rem; color:var(--fg-dim);">Add a passkey to sign in faster next time, without typing your password.</div>' +
                '</div>' +
            '</div>' +
            '<div style="display:flex; gap:.5rem; justify-content:flex-end;">' +
                '<button type="button" id="secure-prompt-later" class="gm-btn gm-btn-ghost gm-btn-sm">Later</button>' +
                '<button type="button" id="secure-prompt-setup" class="gm-btn gm-btn-primary gm-btn-sm">Set up now</button>' +
            '</div>';

        document.body.appendChild(banner);

        function dismiss() {
            sessionStorage.setItem('gm_secure_prompt_dismissed', '1');
            banner.remove();
        }

        document.getElementById('secure-prompt-later').addEventListener('click', dismiss);
        document.getElementById('secure-prompt-setup').addEventListener('click', function () {
            dismiss();
            if (isPortal) {
                var navBtn = document.querySelector('[data-portal-nav="settings"]');
                if (navBtn) navBtn.click();
            } else if (window.GM_SHELL && window.GM_SHELL.gotoItem) {
                window.GM_SHELL.gotoItem('accounts');
            }
        });
    }

    // Shared post-login success path — role-driven (showAdminDashboard
    // itself routes 'member' to the Player Portal, everything else to the
    // admin dashboard), so it works unchanged regardless of which method
    // (password, passkey, backup code) or which of the two login screens
    // produced the session. Extracted so passkey/backup-code sign-in don't
    // duplicate ~70 lines of guild/server-restriction bookkeeping.
    async function handleSuccessfulLogin(resp, typedUser) {
        // Cancel any still-pending conditional/autofill passkey listener —
        // harmless no-op if this login itself came from that listener
        // (its controller is already settled by then), but necessary when
        // login succeeded via password/button-passkey/backup-code instead,
        // so a stale listener doesn't linger against now-hidden fields.
        if (window.GM.abortConditionalPasskeyLogin) window.GM.abortConditionalPasskeyLogin();

        var canonicalUser = resp.id || typedUser;
        loginError.classList.add('hidden');
        document.getElementById('password').value = '';

        // Fetch guilds list
        await fetchGuilds();

        // Fetch restriction for new logins if guild_admin or server_admin
        var normalizedLoginRole = window.GM.normalizeRole(resp.role);
        if (normalizedLoginRole === 'guild_admin') {
            try {
                var { data } = await supabase.from('accounts').select('guild').ilike('id', canonicalUser).maybeSingle();
                if (data && data.guild) {
                    window.currentGuildRestriction = data.guild;
                    window.currentGuild = data.guild;
                    localStorage.setItem('gm_current_guild', data.guild);
                    localStorage.setItem('gm_guild_restriction', data.guild);
                    localStorage.removeItem('gm_server_restriction');
                } else {
                    window.currentGuildRestriction = null;
                    localStorage.removeItem('gm_guild_restriction');
                    localStorage.removeItem('gm_server_restriction');
                }
            } catch (err) {
                console.error('Failed to load login guild restriction:', err);
                window.currentGuildRestriction = null;
                localStorage.removeItem('gm_guild_restriction');
                localStorage.removeItem('gm_server_restriction');
            }
        } else if (normalizedLoginRole === 'server_admin') {
            try {
                var { data } = await supabase.from('accounts').select('guild, server_number').ilike('id', canonicalUser).maybeSingle();
                var sNum = data && data.server_number;
                if (!sNum && data && data.guild) {
                    var { data: g } = await supabase.from('guilds').select('server_number').eq('id', data.guild).maybeSingle();
                    if (g && g.server_number) sNum = g.server_number;
                }
                if (sNum) {
                    localStorage.setItem('gm_server_restriction', sNum);
                } else {
                    localStorage.removeItem('gm_server_restriction');
                }
                window.currentGuildRestriction = null;
                localStorage.removeItem('gm_guild_restriction');
            } catch (err) {
                console.error('Failed to load login server restriction:', err);
                window.currentGuildRestriction = null;
                localStorage.removeItem('gm_guild_restriction');
                localStorage.removeItem('gm_server_restriction');
            }
        } else {
            window.currentGuildRestriction = null;
            localStorage.removeItem('gm_guild_restriction');
            localStorage.removeItem('gm_server_restriction');
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
        if (role !== 'member' && window.GM_LEADER_HALL && window.GM_LEADER_HALL.initGlobalUnreadListener) {
            window.GM_LEADER_HALL.initGlobalUnreadListener();
        }
        showToast(role === 'super_admin' ? t('toast_login_ok') : (t('toast_welcome') + ' ' + typedUser + ' !'), 'success');

        maybeShowSecureAccountPrompt(resp, role);
    }

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
                await handleSuccessfulLogin(resp, user);
            } else if (resp.error === 'pending_approval') {
                loginError.classList.remove('hidden');
                var pe = loginError.querySelector('span:last-of-type');
                if (pe) pe.textContent = 'Your account is awaiting approval by a guild admin.';
            } else if (resp && resp.error === 'invalid_credentials') {
                loginError.classList.remove('hidden');
                var pe = loginError.querySelector('span:last-of-type');
                if (pe) pe.textContent = t('login_error');
            } else if (resp && resp.error === 'too_many_attempts') {
                loginError.classList.remove('hidden');
                var pe = loginError.querySelector('span:last-of-type');
                if (pe) pe.textContent = 'Too many attempts. Please wait a few minutes and try again.';
            } else if (resp && resp.error === 'account_locked') {
                loginError.classList.remove('hidden');
                var pe = loginError.querySelector('span:last-of-type');
                if (pe) pe.textContent = 'This account is temporarily locked after too many failed attempts.';
            } else {
                loginError.classList.remove('hidden');
                var pe = loginError.querySelector('span:last-of-type');
                if (pe) pe.textContent = (resp && resp.error) ? resp.error : t('login_error');
            }
        } catch (err) {
            console.error('Login error details:', err);
            loginError.classList.remove('hidden');
            var pe = loginError.querySelector('span:last-of-type');
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

    // ─── Player self-registration & M3 Segmented Switcher ───────────────────
    var goToRegisterBtn = document.getElementById('go-to-register-btn');
    var registerBackBtn = document.getElementById('register-back-btn');
    var authTabSignin   = document.getElementById('auth-tab-signin');
    var authTabRegister = document.getElementById('auth-tab-register');
    var loginCard       = document.querySelector('#login-form');
    var loginHero       = document.querySelector('.gm-login-hero-tag');

    function showRegisterForm(show) {
        if (registerForm) registerForm.classList.toggle('hidden', !show);
        if (loginForm) loginForm.classList.toggle('hidden', show);
        if (registerError) registerError.classList.add('hidden');
        if (authTabSignin) authTabSignin.classList.toggle('active', !show);
        if (authTabRegister) authTabRegister.classList.toggle('active', !!show);
    }

    if (authTabSignin) authTabSignin.addEventListener('click', function () { showRegisterForm(false); });
    if (authTabRegister) authTabRegister.addEventListener('click', function () { showRegisterForm(true); });
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
                    var regMsg = registerError.querySelector('span:last-of-type');
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
        localStorage.removeItem('gm_server_restriction');
        localStorage.removeItem('gm_portal_session');
        window.currentGuildRestriction = null;
        window.currentServerRestriction = null;
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

        dashboardView.classList.remove('hidden');
        dashboardView.classList.add('active');

        var adminHomeBtn = document.querySelector('.nav-tab[data-tab="admin-home"]');
        var roleLabel = document.getElementById('nav-user-role');
        var nameLabel = document.getElementById('nav-user-name');

        var isR5 = (role !== 'member'); // super_admin & guild_admin

        if (isR5) {
            renderGuildsSubscriptionList();
            renderMigrationGroupsList();
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
        loginView.classList.remove('hidden');
        loginView.classList.add('active');
        startConditionalPasskeyListener();
    }

    // Arms (or re-arms, superseding any previous one) the conditional/
    // autofill passkey listener. Silent by design: it shows no UI of its
    // own until the user actually picks a suggestion from their password
    // manager, so resolving to null (unsupported browser, nothing picked,
    // superseded by a fresh call) is the normal, expected outcome, not an
    // error to report. Also called once, unconditionally, at page load
    // below — #login-view starts visible in the raw HTML on a fresh load
    // with no session, so showLogin() itself is never called in that case.
    function startConditionalPasskeyListener() {
        if (!window.GM.startConditionalPasskeyLogin) return;
        window.GM.startConditionalPasskeyLogin().then(function (resp) {
            if (resp && resp.ok) {
                handleSuccessfulLogin(resp, resp.id);
            }
        }).catch(function () {});
    }
    startConditionalPasskeyListener();

    function triggerTabDataLoad(tabId) {
        if (!tabId) return;
        if (tabId !== 'tab-leader-hall') {
            var blackout = document.getElementById('gm-anti-capture-fullscreen-overlay');
            if (blackout) blackout.classList.add('hidden');
            document.body.classList.remove('gm-mobile-chat-open');
        }
        if (tabId === 'admin-members' || tabId === 'member-members' || tabId === 'member-home') {
            fetchGuildMembers();
        }
        if (tabId === 'admin-home') {
            fetchAccounts();
            loadGuildSettings();
            populateAccountGuildSelect();
            wireJoinCode();
            loadMyPasskeysCard();
        }
        if (tabId === 'admin-discord') {
            loadGuildSettings();
        }
        if (tabId === 'admin-superadmin') {
            renderGuildsSubscriptionList();
            renderMigrationGroupsList();
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
            // Draft is the default sub-tab; SvS/GvG are switched via the
            // settings sub-tab bar (wired in shell.js).
            window.GM_SETTINGS.load();
        }
        if (tabId === 'tab-tickets' && window.GM_TICKETS) {
            window.GM_TICKETS.load();
        }
        if (tabId === 'tab-leader-hall' && window.GM_LEADER_HALL) {
            window.GM_LEADER_HALL.load();
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

            var roleInput = document.getElementById('superadmin-account-role');
            var roleSelected = roleInput ? roleInput.value : 'guild_admin';

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
                    role: roleSelected,
                    guild: guildSelected
                });
                if (!res.ok) throw new Error(res.error || 'create_failed');

                // Store password in memory cache (not in DOM) right after creation.
                pendingPasswords[identifier] = newPassword;
                accounts.unshift({ 
                    id: identifier, 
                    role: roleSelected, 
                    guild: guildSelected, 
                    created_at: new Date().toISOString() 
                });
                renderAccounts();
                if (idInput) idInput.value = '';
                showToast('Admin account ' + identifier + ' (' + roleSelected + ') created for guild ' + guildSelected + '!', 'success');
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
        var notifyGvgDailyTasks = await window.GM.config.get('notify_gvg_daily_tasks');
        var notifyGvgPvp = await window.GM.config.get('notify_gvg_pvp');
        
        var notifySvsGarrison = await window.GM.config.get('notify_svs_garrison');
        var notifySvsPvp = await window.GM.config.get('notify_svs_pvp');
        var notifySvsWonPrep = await window.GM.config.get('notify_svs_won_prep');

        // Server & Guild Tag Configuration
        var tagSettingEl = document.getElementById('guild-tag-setting');
        if (tagSettingEl) {
            var currentTag = await window.GM.getGuildTag();
            tagSettingEl.value = currentTag || '';
        }
        var serverNumSettingEl = document.getElementById('guild-server-number-setting');
        if (serverNumSettingEl) {
            var sNum = await window.GM.config.get('server_number');
            serverNumSettingEl.value = sNum || '';
        }

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
        setCheckedState('notify-gvg-daily-tasks', notifyGvgDailyTasks, true);
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
                
                var tagSettingEl = document.getElementById('guild-tag-setting');
                var tagVal = '';
                if (tagSettingEl) {
                    var rawTag = tagSettingEl.value.trim().toUpperCase();
                    if (rawTag) {
                        if (!rawTag.startsWith('[') && !rawTag.endsWith(']')) {
                            tagVal = '[' + rawTag + ']';
                        } else {
                            tagVal = rawTag;
                        }
                    }
                }
                var serverNumSettingEl = document.getElementById('guild-server-number-setting');
                var serverNumVal = serverNumSettingEl ? serverNumSettingEl.value.trim() : '';

                await Promise.all([
                    window.GM.config.set('guild_tag', tagVal),
                    window.GM.config.set('server_number', serverNumVal),
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
                    window.GM.config.set('notify_gvg_daily_tasks', (showCalamityGvgSvs && document.getElementById('notify-gvg-daily-tasks').checked) ? 'true' : 'false'),
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

    var btnDispatchGvgTasks = document.getElementById('btn-dispatch-gvg-tasks');
    if (btnDispatchGvgTasks) {
        btnDispatchGvgTasks.addEventListener('click', async function () {
            btnDispatchGvgTasks.disabled = true;
            try {
                var dateUtc = new Date();
                var curDay = dateUtc.getUTCDay(); // 1=Mon .. 6=Sat
                if (curDay < 1 || curDay > 6) curDay = 1; // Default to Monday if Sunday
                
                var roleInput = document.getElementById('discord-role-id-gvg');
                var roleVal = roleInput ? roleInput.value.trim() : '';
                var roleMention = '@everyone';
                if (roleVal) {
                    if (roleVal.match(/\d{15,22}/)) roleMention = '<@&' + roleVal.match(/\d{15,22}/)[0] + '>';
                    else roleMention = roleVal;
                }
                
                var payload = (window.GM && window.GM.gvgTasks && typeof window.GM.gvgTasks.buildGvgDailyTaskEmbed === 'function')
                    ? window.GM.gvgTasks.buildGvgDailyTaskEmbed(curDay, roleMention)
                    : (window.GM_GVG_TASKS && typeof window.GM_GVG_TASKS.buildGvgDailyTaskEmbed === 'function')
                        ? window.GM_GVG_TASKS.buildGvgDailyTaskEmbed(curDay, roleMention)
                        : null;
                
                if (!payload) throw new Error('GvG task generator unavailable');
                
                var webhookInput = document.getElementById('webhook-gvg');
                var webhookUrl = webhookInput ? webhookInput.value.trim() : '';
                
                var res = await window.GM.sendDiscordWebhookDetailed('gvg', payload, webhookUrl);
                if (res && res.ok) {
                    showToast('GvG Day ' + curDay + ' tasks successfully sent to Discord!', 'success');
                } else {
                    showToast('Failed to send Discord webhook: ' + (res && res.error ? res.error : 'Unknown error'), 'error');
                }
            } catch (err) {
                showToast('Error: ' + err.message, 'error');
            } finally {
                btnDispatchGvgTasks.disabled = false;
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
                return acc.role === 'guild_admin' || acc.role === 'server_admin' || acc.role === 'super_admin';
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
            var g = acc.guild || '';
            var sNum = acc.server_number || (g ? getServerNumberForGuild(g) : '');
            var sKey = sNum ? ('Server #' + sNum) : (acc.role === 'super_admin' ? 'Super Admin Master Accounts' : 'Unassigned Server');
            if (!groupedByServer[sKey]) {
                groupedByServer[sKey] = { serverKey: sKey, sNum: sNum, accounts: [], guildsSet: {} };
            }
            groupedByServer[sKey].accounts.push(acc);
            if (g) groupedByServer[sKey].guildsSet[g] = true;
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
                            '<span style="font-weight:700; color:var(--fg); font-size:0.9rem;">' + esc(guildsList || 'All Tenants') + '</span>' +
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
            var roleLabel = 'Guild Admin';
            var chipCls = 'gm-chip-info';

            if (role === 'super_admin') {
                roleLabel = 'Super Admin';
                chipCls = 'gm-chip-accent';
            } else if (role === 'server_admin') {
                roleLabel = 'Server Admin';
                chipCls = 'gm-chip-warning';
            } else if (role === 'member') {
                roleLabel = 'Member';
                chipCls = 'gm-chip-lilac';
            }
            var dateStr = acc.created_at ? new Date(acc.created_at).toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' }) : '-';
            var guildLabel = acc.guild ? 'Guild: ' + acc.guild : 'All Guilds';
            var guildCls = acc.guild ? 'gm-chip-warning' : 'gm-chip-success';

            var isSuperAdminAccount = (role === 'super_admin');
            
            // Password management permission:
            var canManagePass = isSuperAdminUser || !isSuperAdminAccount;
            
            // Delete permission:
            var canDelete = isSuperAdminUser || !isSuperAdminAccount;

            var passHtml = '';
            if (canManagePass) {
                passHtml = '<div class="gm-cred-pass gm-masked" data-acc-id="' + esc(acc.id) + '">' +
                               '<span class="gm-pwd-text">••••••••••••</span>' +
                               '<button class="gm-mini-btn gm-cred-reset" title="Renew Password"><i class="ph ph-arrows-clockwise"></i></button>' +
                               '<button class="gm-mini-btn gm-cred-copy hidden" title="Copy Password"><i class="ph ph-copy"></i></button>' +
                               '<button class="gm-mini-btn gm-cred-reset-passkeys" title="Reset Passkeys (revoke all passkeys + backup codes)"><i class="ph ph-fingerprint"></i></button>' +
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

            var roleSelectHtml = '';
            var guildSelectHtml = '';
            if (isSuperAdminUser) {
                roleSelectHtml = '<select class="gm-select gm-select-sm gm-account-role-select" data-id="' + esc(acc.id) + '" style="font-size: 0.75rem; padding: 0.15rem 0.4rem; height: auto; width: auto; min-width: 105px; border-radius: 4px; line-height: 1.2; font-weight: 600;">' +
                                     '<option value="guild_admin"' + (role === 'guild_admin' ? ' selected' : '') + '>Guild Admin</option>' +
                                     '<option value="server_admin"' + (role === 'server_admin' ? ' selected' : '') + '>Server Admin</option>' +
                                     '<option value="super_admin"' + (role === 'super_admin' ? ' selected' : '') + '>Super Admin</option>' +
                                     '<option value="member"' + (role === 'member' ? ' selected' : '') + '>Member</option>' +
                                 '</select>';

                var options = '<option value="ALL"' + (!acc.guild ? ' selected' : '') + '>All Guilds</option>';
                (window.guildsList || []).forEach(function (g) {
                    options += '<option value="' + esc(g) + '"' + (acc.guild === g ? ' selected' : '') + '>' + esc(g) + '</option>';
                });
                guildSelectHtml = '<select class="gm-select gm-select-sm gm-account-guild-select" data-id="' + esc(acc.id) + '" style="font-size: 0.75rem; padding: 0.15rem 0.4rem; height: auto; width: auto; min-width: 90px; border-radius: 4px; line-height: 1.2;">' +
                                      options +
                                  '</select>';
            } else {
                roleSelectHtml = '<span class="gm-chip ' + chipCls + '">' + esc(roleLabel) + '</span>';
                guildSelectHtml = '<span class="gm-chip ' + guildCls + '" style="font-size: 0.7rem;">' + esc(guildLabel) + '</span>';
            }

            html +=
                '<div class="gm-cred-card" data-acc-id="' + esc(acc.id) + '">' +
                    '<div class="gm-row" style="justify-content:space-between; margin-bottom: 0.25rem;">' +
                        '<div class="gm-cred-name">' + esc(acc.id) + '</div>' +
                        '<div class="gm-row" style="gap: 0.25rem; align-items: center;">' +
                            roleSelectHtml +
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
                    var res = await window.GM.adminAccounts('reset-password', { id: accId });
                    if (!res.ok) throw new Error(res.error || 'reset_failed');
                    var pass = res.password;
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

        // Admin escape hatch: revoke all passkeys + backup codes for an
        // account that's lost every device (same authorization boundary as
        // reset-password, enforced server-side — this button is just UX).
        container.querySelectorAll('.gm-cred-reset-passkeys').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var wrap = btn.closest('.gm-cred-pass');
                var accId = wrap.getAttribute('data-acc-id');
                showConfirm(
                    'Reset Passkeys',
                    'This revokes <strong>all</strong> passkeys and backup codes for <strong>' + esc(accId) + '</strong>. They will need to sign in with their password and set up passkeys again. Continue?',
                    async function () {
                        var icon = btn.querySelector('i');
                        var originalClass = icon ? icon.className : '';
                        btn.disabled = true;
                        if (icon) icon.className = 'ph ph-circle-notch ph-spin';
                        try {
                            var res = await window.GM.webauthn.adminResetPasskeys(accId);
                            if (!res.ok) throw new Error(res.error || 'reset_failed');
                            showToast('Passkeys reset for ' + accId + '.', 'success');
                        } catch (err) {
                            showToast('Could not reset passkeys: ' + err.message, 'error');
                        } finally {
                            btn.disabled = false;
                            if (icon) icon.className = originalClass;
                        }
                    }
                );
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

        container.querySelectorAll('.gm-account-role-select').forEach(function (sel) {
            sel.addEventListener('change', async function () {
                var id = sel.getAttribute('data-id');
                var newRole = sel.value;
                var acc = accounts.find(function (a) { return (a.id || '').toLowerCase() === (id || '').toLowerCase(); });
                sel.disabled = true;
                try {
                    var res = await window.GM.adminAccounts('update-role', {
                        id: id,
                        role: newRole,
                        guild: acc ? acc.guild : null
                    });
                    if (!res.ok) throw new Error(res.error || 'update_failed');
                    showToast('Role for ' + id + ' updated to ' + newRole + ' successfully!', 'success');
                    
                    if (acc) {
                        acc.role = newRole;
                        if (res.server_number) acc.server_number = res.server_number;
                    }
                    renderAccounts();
                } catch (err) {
                    showToast('Error updating role: ' + err.message, 'error');
                    fetchAccounts();
                } finally {
                    sel.disabled = false;
                }
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

    // ─── My Passkeys (WebAuthn) — self-service enrollment for the currently
    // logged-in account. The list/rename/remove/backup-codes UI itself is
    // shared with the player Portal's own Security section (gm-webauthn.js
    // mountPasskeysPanel) so that ~250 lines of markup/wiring exist once,
    // not duplicated per panel. Mounted once here since these buttons are
    // static index.html elements (unlike the portal, which rebuilds its
    // whole settings panel on every render); loadMyPasskeysCard() below
    // triggers the actual data fetch, called on admin-home tab activation.
    var myPasskeysPanel = window.GM.webauthn ? window.GM.webauthn.mountPasskeysPanel({
        listEl: document.getElementById('my-passkeys-list'),
        addBtnEl: document.getElementById('add-passkey-btn'),
        regenBtnEl: document.getElementById('regen-backup-codes-btn'),
        regenLabelEl: document.getElementById('backup-codes-btn-label')
    }) : null;

    function loadMyPasskeysCard() {
        if (myPasskeysPanel) myPasskeysPanel.reload();
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

                    // Note: Super admin subscription editor remains functional but is cosmetic since is_subscription_active() always returns true in v127.0+
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

    // ─── Cross-Server Migration Groups (Super Admin) ────────────────────────
    var migrationGroupsFormWired = false;

    async function renderMigrationGroupsList() {
        var container = document.getElementById('migration-groups-list-container');
        if (!container || !supabase) return;

        if (!migrationGroupsFormWired) {
            migrationGroupsFormWired = true;
            var form = document.getElementById('create-migration-group-form');
            if (form) {
                form.addEventListener('submit', async function (e) {
                    e.preventDefault();
                    var nameInput = document.getElementById('migration-group-name');
                    var serversInput = document.getElementById('migration-group-servers');
                    var name = nameInput.value.trim();
                    var serverNumbers = serversInput.value.split(',')
                        .map(function (s) { return s.trim(); })
                        .filter(Boolean);
                    var uniqueServers = Array.from(new Set(serverNumbers));

                    if (!name || uniqueServers.length < 2) {
                        showToast('Enter a group name and at least 2 distinct server numbers.', 'error');
                        return;
                    }

                    var submitBtn = form.querySelector('button[type="submit"]');
                    submitBtn.disabled = true;
                    try {
                        var groupRes = await supabase.from('server_migration_groups')
                            .insert([{ name: name, status: 'open' }])
                            .select('id')
                            .single();
                        if (groupRes.error) throw new Error(groupRes.error.message);

                        var groupId = groupRes.data.id;
                        var linkRes = await supabase.from('server_migration_group_servers')
                            .insert(uniqueServers.map(function (s) { return { group_id: groupId, server_number: s }; }));
                        if (linkRes.error) throw new Error(linkRes.error.message);

                        showToast('Migration group "' + name + '" opened for servers: ' + uniqueServers.join(', '), 'success');
                        nameInput.value = '';
                        serversInput.value = '';
                        renderMigrationGroupsList();
                    } catch (err) {
                        showToast('Error creating migration group: ' + err.message, 'error');
                    } finally {
                        submitBtn.disabled = false;
                    }
                });
            }
        }

        try {
            var [groupsRes, serversRes] = await Promise.all([
                supabase.from('server_migration_groups').select('id, name, status').order('created_at', { ascending: false }),
                supabase.from('server_migration_group_servers').select('group_id, server_number')
            ]);
            if (groupsRes.error) throw groupsRes.error;

            var groups = groupsRes.data || [];
            if (groups.length === 0) {
                container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">No migration groups yet</div></div>';
                return;
            }

            var serversByGroup = {};
            (serversRes.data || []).forEach(function (r) {
                if (!serversByGroup[r.group_id]) serversByGroup[r.group_id] = [];
                serversByGroup[r.group_id].push(r.server_number);
            });

            var html = '';
            groups.forEach(function (g) {
                var isOpen = g.status === 'open';
                var servers = (serversByGroup[g.id] || []).slice().sort();
                var serversHtml = servers.map(function (s) {
                    return '<span class="gm-chip" style="font-size:0.75rem; margin-right:4px;"><i class="ph ph-hard-drives"></i> #' + esc(s) + '</span>';
                }).join('');
                var statusBadge = isOpen
                    ? '<span class="gm-chip gm-chip-success" style="font-weight:700;"><i class="ph ph-lock-open"></i> Open</span>'
                    : '<span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3); font-weight:700;"><i class="ph ph-lock"></i> Closed</span>';

                html +=
                    '<div class="gm-card glass-card" style="margin-bottom:0.75rem; padding:0.9rem 1.1rem;">' +
                        '<div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">' +
                            '<div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">' +
                                '<strong style="font-size:0.95rem;">' + esc(g.name) + '</strong>' +
                                statusBadge +
                            '</div>' +
                            '<button type="button" class="gm-btn gm-btn-sm ' + (isOpen ? 'gm-btn-danger' : 'gm-btn-success') + '" data-migration-group-id="' + esc(g.id) + '" data-migration-group-action="' + (isOpen ? 'close' : 'reopen') + '">' +
                                '<i class="ph ' + (isOpen ? 'ph-lock' : 'ph-lock-open') + '"></i> <span>' + (isOpen ? 'Close' : 'Reopen') + '</span>' +
                            '</button>' +
                        '</div>' +
                        '<div style="margin-top:0.5rem;">' + (serversHtml || '<span style="font-size:0.78rem; color:var(--text-dim);">No servers linked</span>') + '</div>' +
                    '</div>';
            });
            container.innerHTML = html;

            container.querySelectorAll('[data-migration-group-action]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var groupId = btn.getAttribute('data-migration-group-id');
                    var action = btn.getAttribute('data-migration-group-action');
                    var newStatus = action === 'close' ? 'closed' : 'open';
                    var confirmMsg = action === 'close'
                        ? 'Close this migration group? Admins will no longer be able to transfer players between these servers, and any pending request made under it can no longer be approved.'
                        : 'Reopen this migration group? Admins on these servers will be able to transfer players between them again.';
                    window.showConfirm(action === 'close' ? 'Close Migration Group' : 'Reopen Migration Group', confirmMsg, async function () {
                        btn.disabled = true;
                        try {
                            var updatePayload = { status: newStatus, closed_at: newStatus === 'closed' ? new Date().toISOString() : null };
                            var res = await supabase.from('server_migration_groups').update(updatePayload).eq('id', groupId);
                            if (res.error) throw new Error(res.error.message);
                            showToast('Migration group ' + (newStatus === 'closed' ? 'closed' : 'reopened') + '.', 'success');
                            renderMigrationGroupsList();
                        } catch (err) {
                            showToast('Error updating migration group: ' + err.message, 'error');
                            btn.disabled = false;
                        }
                    });
                });
            });
        } catch (err) {
            container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-warning-octagon gm-icon" style="color:var(--danger);"></i><div class="gm-empty-title">Error: ' + esc(err.message) + '</div></div>';
        }
    }

    // ─── OCR Bulk Roster & Power Import ─────────────────────────────────────
    var ocrExtractedPlayers = [];
    var ocrInitialized = false;

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

    var OCR_METRICS_META = {
        members: {
            title: '1. Members OCR — Full Roster Management',
            subtitle: 'Upload full guild roster screenshots to add recruits (with real UID validation), update power, assign R1-R4 rank from the roster\'s section headers, and detect removed members',
            dropTitle: 'Drop full guild roster screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Full Roster: adds, updates, assigns rank, and detects departures)',
            header: 'Members',
            field: 'overall_power',
            color: '#10b981',
            icon: 'ph-users',
            isMultiGuild: false,
            isEvent: false
        },
        power: {
            title: '2. Power OCR — Overall Total Power',
            subtitle: 'Upload guild roster screenshots to update overall power levels (update-only for existing members)',
            dropTitle: 'Drop Overall Power screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Intra-Guild: updates existing roster members)',
            header: 'Extracted Power',
            field: 'overall_power',
            color: '#818cf8',
            icon: 'ph-sword',
            isMultiGuild: false
        },
        fleet: {
            title: '3. Fleet OCR — Strongest Fleet Rating (Server Leaderboard)',
            subtitle: 'Upload Strongest Fleet / March 1 leaderboards to update strike ratings and rally capabilities',
            dropTitle: 'Drop Strongest Fleet leaderboard screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Server Leaderboard: filters by your Guild Tag)',
            header: 'Extracted Fleet Rating',
            field: 'fleet_rating',
            color: '#60a5fa',
            icon: 'ph-swords',
            isMultiGuild: true
        },
        tech: {
            title: '4. Tech OCR — Technology Power',
            subtitle: 'Upload Technology Power leaderboards to track research advancement across members',
            dropTitle: 'Drop Technology Power leaderboard screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Intra-Guild: extracts Alliance/Individual Tech values)',
            header: 'Extracted Tech Power',
            field: 'tech_power',
            color: '#a78bfa',
            icon: 'ph-atom',
            isMultiGuild: false
        },
        flagship: {
            title: '5. Flagship OCR — Flagship Power (Server Leaderboard)',
            subtitle: 'Upload Flagship power leaderboards to track capital ship strength and hulls',
            dropTitle: 'Drop Flagship Power leaderboard screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Server Leaderboard: filters by your Guild Tag)',
            header: 'Extracted Flagship Power',
            field: 'flagship_power',
            color: '#fbbf24',
            icon: 'ph-rocket',
            isMultiGuild: true
        },
        champs: {
            title: '6. Champs OCR — Champions Total Power (Server Leaderboard)',
            subtitle: 'Upload Champion Total Power leaderboards to track hero collections and ranks',
            dropTitle: 'Drop Champions Total Power leaderboard screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Server Leaderboard: filters by your Guild Tag)',
            header: 'Extracted Champions Power',
            field: 'champion_power',
            color: '#f472b6',
            icon: 'ph-crown',
            isMultiGuild: true
        },
        crew: {
            title: '7. Crew OCR — Crew Total Power (Server Leaderboard)',
            subtitle: 'Upload Crew Total Power leaderboards to evaluate Foundation officer development',
            dropTitle: 'Drop Crew Total Power leaderboard screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Server Leaderboard: filters by your Guild Tag)',
            header: 'Extracted Crew Power',
            field: 'crew_power',
            color: '#38bdf8',
            icon: 'ph-users-three',
            isMultiGuild: true
        },
        glory: {
            title: '8. Glory OCR — Weekly Glory Score',
            subtitle: 'Upload Glory rankings to track weekly battle points and PvP contribution',
            dropTitle: 'Drop Glory Ranking leaderboard screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Intra-Guild: extracts Glory score points)',
            header: 'Extracted Glory Score',
            field: 'glory_score',
            color: '#34d399',
            icon: 'ph-trophy',
            isMultiGuild: false
        },
        svs_prep: {
            title: 'SvS Day 1 to 5 OCR — Preparation Stage',
            subtitle: 'Upload SvS Day 1-5 screenshots to import prep scores and validate participation for your guild',
            dropTitle: 'Drop SvS Day 1 to 5 screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Targets members with your Guild Tag)',
            header: 'SvS Prep Score',
            field: 'score_prep',
            color: '#f59e0b',
            icon: 'ph-sword',
            isMultiGuild: true,
            isEvent: true,
            eventType: 'standard',
            eventKey: 'SvS'
        },
        svs_pvp: {
            title: 'SvS Day 6 OCR — PvP Battle Day',
            subtitle: 'Upload SvS Day 6 PvP screenshots to import battle scores and validate participation for your guild',
            dropTitle: 'Drop SvS Day 6 PvP screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Targets members with your Guild Tag)',
            header: 'SvS PvP Score',
            field: 'score_pvp',
            color: '#f97316',
            icon: 'ph-fire',
            isMultiGuild: true,
            isEvent: true,
            eventType: 'standard',
            eventKey: 'SvS'
        },
        gvg_prep: {
            title: 'GvG Day 1 to 5 OCR — Preparation Stage',
            subtitle: 'Upload GvG Day 1-5 screenshots to import prep scores and validate participation for your guild',
            dropTitle: 'Drop GvG Day 1 to 5 screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Targets members with your Guild Tag)',
            header: 'GvG Prep Score',
            field: 'score_prep',
            color: '#60a5fa',
            icon: 'ph-flag-banner',
            isMultiGuild: true,
            isEvent: true,
            eventType: 'standard',
            eventKey: 'GvG'
        },
        gvg_pvp: {
            title: 'GvG Day 6 OCR — PvP Battle Day',
            subtitle: 'Upload GvG Day 6 PvP screenshots to import battle scores and validate participation for your guild',
            dropTitle: 'Drop GvG Day 6 PvP screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Targets members with your Guild Tag)',
            header: 'GvG PvP Score',
            field: 'score_pvp',
            color: '#38bdf8',
            icon: 'ph-swords',
            isMultiGuild: true,
            isEvent: true,
            eventType: 'standard',
            eventKey: 'GvG'
        },
        shadowfront_s1: {
            title: 'Shadowfront S1 OCR — Squad 1 Battle & Roster',
            subtitle: 'Upload Shadowfront Squad 1 screenshots to validate Main squad (Participated) and Substitutes (Sub Present + Participated)',
            dropTitle: 'Drop Shadowfront Squad 1 screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Detects Squad 1 Main & Reserve members)',
            header: 'Squad 1 Status',
            field: 'participated',
            color: '#a855f7',
            icon: 'ph-users-three',
            isMultiGuild: false,
            isEvent: true,
            eventType: 'shadowfront',
            squad: 'squad1'
        },
        shadowfront_s2: {
            title: 'Shadowfront S2 OCR — Squad 2 Battle & Roster',
            subtitle: 'Upload Shadowfront Squad 2 screenshots to validate Main squad (Participated) and Substitutes (Sub Present + Participated)',
            dropTitle: 'Drop Shadowfront Squad 2 screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Detects Squad 2 Main & Reserve members)',
            header: 'Squad 2 Status',
            field: 'participated',
            color: '#d946ef',
            icon: 'ph-users-three',
            isMultiGuild: false,
            isEvent: true,
            eventType: 'shadowfront',
            squad: 'squad2'
        },
        dtr: {
            title: 'DTR OCR — Defend Trade Route',
            subtitle: 'Upload DTR screenshots to validate Participated (>0 pts) or Appointed + Participated (=0 pts)',
            dropTitle: 'Drop Defend Trade Route screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Auto-determines Participated vs Appointed)',
            header: 'DTR Status',
            field: 'participated',
            color: '#10b981',
            icon: 'ph-truck',
            isMultiGuild: false,
            isEvent: true,
            eventType: 'standard',
            eventKey: 'Defend Trade Route'
        },
        armsrace_sa: {
            title: 'Arms Race SA OCR — Stage A Participation',
            subtitle: 'Upload Stage A screenshots to validate member participation',
            dropTitle: 'Drop Arms Race Stage A screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Validates Stage A Participated)',
            header: 'Stage A Status',
            field: 'participated',
            color: '#f43f5e',
            icon: 'ph-bolt',
            isMultiGuild: false,
            isEvent: true,
            eventType: 'armsrace',
            stage: 'stageA'
        },
        armsrace_sb: {
            title: 'Arms Race SB OCR — Stage B Participation',
            subtitle: 'Upload Stage B screenshots to validate member participation',
            dropTitle: 'Drop Arms Race Stage B screenshots here or click to browse',
            dropDesc: 'Screenshots or a scroll-recording video · PNG/JPG/WEBP/MP4/MOV (Validates Stage B Participated)',
            header: 'Stage B Status',
            field: 'participated',
            color: '#ef4444',
            icon: 'ph-crosshair',
            isMultiGuild: false,
            isEvent: true,
            eventType: 'armsrace',
            stage: 'stageB'
        }
    };

    var currentOcrMetric = 'members';

    async function setOcrMetric(metric) {
        if (!OCR_METRICS_META[metric]) metric = 'members';
        currentOcrMetric = metric;
        var meta = OCR_METRICS_META[metric];

        // Update tab buttons visual state
        document.querySelectorAll('#ocr-metric-tabs .gm-seg-btn').forEach(function (btn) {
            var m = btn.getAttribute('data-metric');
            var isActive = (m === metric);
            btn.classList.toggle('active', isActive);
            btn.style.background = isActive ? (OCR_METRICS_META[m] ? OCR_METRICS_META[m].color : 'var(--accent)') : 'transparent';
            btn.style.color = isActive ? '#fff' : 'var(--text-muted)';
        });

        // Update titles and headers
        var titleEl = document.getElementById('ocr-modal-title');
        var subEl = document.getElementById('ocr-modal-subtitle');
        var dropTitle = document.getElementById('ocr-dropzone-title');
        var dropDesc = document.getElementById('ocr-dropzone-desc');
        var metricHeader = document.getElementById('ocr-metric-header');
        var rankHeader = document.getElementById('ocr-rank-header');

        if (titleEl) titleEl.textContent = meta.title;
        if (subEl) subEl.textContent = meta.subtitle;
        if (dropTitle) dropTitle.textContent = meta.dropTitle;
        if (dropDesc) dropDesc.textContent = meta.dropDesc;
        if (metricHeader) metricHeader.textContent = meta.header;
        if (rankHeader) rankHeader.style.display = (metric === 'members') ? '' : 'none';

        // Update Guild Tag Banner
        var scopeBadge = document.getElementById('ocr-scope-badge');
        var scopeDesc = document.getElementById('ocr-scope-desc');
        var tagInputGroup = document.getElementById('ocr-tag-input-group');
        var tagInput = document.getElementById('ocr-guild-tag-input');

        var configuredTag = (window.GM && window.GM.getGuildTag) ? (await window.GM.getGuildTag()) : '';
        if (tagInput && (!tagInput.value || tagInput.dataset.autoFilled === 'true')) {
            tagInput.value = configuredTag || '';
            tagInput.dataset.autoFilled = 'true';
        }

        if (meta.isMultiGuild) {
            if (scopeBadge) {
                scopeBadge.innerHTML = '<i class="ph ph-globe"></i> Leaderboard (Tag Filtered)';
                scopeBadge.style.background = 'rgba(234,179,8,0.18)';
                scopeBadge.style.color = '#facc15';
            }
            if (scopeDesc) {
                var displayTag = (tagInput && tagInput.value) ? tagInput.value : configuredTag;
                scopeDesc.textContent = 'Screenshots contain multi-guild players. Targeting members with tag ' + displayTag + '.';
            }
            if (tagInputGroup) tagInputGroup.style.display = 'flex';
        } else if (meta.isEvent) {
            if (scopeBadge) {
                scopeBadge.innerHTML = '<i class="' + (meta.icon || 'ph-sword') + '"></i> Event Session Scan';
                scopeBadge.style.background = 'rgba(99,102,241,0.18)';
                scopeBadge.style.color = meta.color || 'var(--accent)';
            }
            if (scopeDesc) {
                scopeDesc.textContent = meta.subtitle || 'Screenshots will update event participants for active session.';
            }
            if (tagInputGroup) tagInputGroup.style.display = 'none';
        } else {
            if (scopeBadge) {
                scopeBadge.innerHTML = '<i class="ph ph-shield-check"></i> Intra-Guild Scan';
                scopeBadge.style.background = 'rgba(99,102,241,0.18)';
                scopeBadge.style.color = 'var(--accent)';
            }
            if (scopeDesc) {
                scopeDesc.textContent = 'Screenshots contain exclusively your guild members (full roster scan).';
            }
            if (tagInputGroup) tagInputGroup.style.display = 'none';
        }
    }

    async function openOcrModal(metric) {
        initOcrGeminiModule();
        await setOcrMetric(metric || 'power');
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
        var filterInput = document.getElementById('ocr-filter-search');

        if (dropzone) dropzone.style.display = 'block';
        if (loading) loading.style.display = 'none';
        if (resultsContainer) resultsContainer.style.display = 'none';
        if (btnCommit) btnCommit.style.display = 'none';
        if (fileInput) fileInput.value = '';
        if (filterInput) filterInput.value = '';
    }

    window.openOcrModal = openOcrModal;
    window.closeOcrModal = closeOcrModal;
    window.GM = window.GM || {};
    window.GM.openOcrModal = openOcrModal;
    window.GM.closeOcrModal = closeOcrModal;
    window.GM.parseGeminiJson = parseGeminiJson;
    window.GM.getOcrModel = getOcrModel;
    window.GM.fetchGuildMembers = fetchGuildMembers;
    window.GM.renderGuildMembers = renderGuildMembers;
    window.GM.bulkUpdateMemberRoles = bulkUpdateMemberRoles;
    window.GM.setGuildMembersForTest = function (list) { guildMembers = list; };

    // Document-level event delegation for OCR trigger buttons
    document.addEventListener('click', function (e) {
        var btn = e.target.closest('#btn-ocr-import, #btn-ocr-import-member, .btn-ocr-trigger');
        if (btn) {
            e.preventDefault();
            e.stopPropagation();
            var metric = btn.getAttribute('data-metric') || 'power';
            openOcrModal(metric);
        }
    });

    var ocrModuleInitialized = false;
    function initOcrGeminiModule() {
        if (ocrModuleInitialized) return;
        ocrModuleInitialized = true;

        var closeBtn = document.getElementById('ocr-modal-close');
        var fileInput = document.getElementById('ocr-file-input');
        var dropzone = document.getElementById('ocr-dropzone');
        var btnReset = document.getElementById('ocr-reset-btn');
        var btnSelectAll = document.getElementById('ocr-select-all-btn');
        var cbToggleAll = document.getElementById('ocr-toggle-all-cb');
        var btnCommit = document.getElementById('ocr-commit-btn');

        // Metric tabs switcher
        var metricTabs = document.getElementById('ocr-metric-tabs');
        if (metricTabs) {
            metricTabs.querySelectorAll('.gm-seg-btn').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var m = btn.getAttribute('data-metric');
                    if (m) setOcrMetric(m);
                });
            });
        }

        // Guild Tag Filter input change
        var tagInput = document.getElementById('ocr-guild-tag-input');
        if (tagInput) {
            tagInput.addEventListener('input', function () {
                tagInput.dataset.autoFilled = 'false';
                var meta = OCR_METRICS_META[currentOcrMetric];
                var scopeDesc = document.getElementById('ocr-scope-desc');
                if (meta && meta.isMultiGuild && scopeDesc) {
                    scopeDesc.textContent = 'Screenshots contain multi-guild players. Targeting members with tag ' + (tagInput.value || '[TAG]') + '.';
                }
            });
        }

        // Roster Toolbar buttons
        document.querySelectorAll('.btn-ocr-trigger').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                var m = btn.getAttribute('data-metric') || 'power';
                openOcrModal(m);
            });
        });

        if (closeBtn) {
            closeBtn.addEventListener('click', closeOcrModal);
        }

        var overlay = document.getElementById('ocr-modal-overlay');
        if (overlay) {
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) closeOcrModal();
            });
        }

        if (dropzone && fileInput) {
            dropzone.addEventListener('click', function () {
                fileInput.click();
            });

            dropzone.addEventListener('dragover', function (e) {
                e.preventDefault();
                dropzone.style.borderColor = '#818cf8';
                dropzone.style.background = 'rgba(99, 102, 241, 0.08)';
            });

            dropzone.addEventListener('dragleave', function () {
                dropzone.style.borderColor = 'rgba(99, 102, 241, 0.4)';
                dropzone.style.background = 'rgba(99, 102, 241, 0.03)';
            });

            dropzone.addEventListener('drop', function (e) {
                e.preventDefault();
                dropzone.style.borderColor = 'rgba(99, 102, 241, 0.4)';
                dropzone.style.background = 'rgba(99, 102, 241, 0.03)';
                var files = Array.from(e.dataTransfer.files || []);
                if (files.length > 0) {
                    handleOcrFiles(files);
                }
            });

            fileInput.addEventListener('change', function () {
                var files = Array.from(fileInput.files || []);
                if (files.length > 0) {
                    handleOcrFiles(files);
                }
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

    // --- Video -> frames -------------------------------------------------
    // Lets someone record a single scroll through a leaderboard instead of
    // taking 25 individual screenshots. Frames are sampled finely (every
    // stepMs) but only KEPT when the visible content actually changed since
    // the last kept frame, via a cheap 12x12 luminance-grid diff — no ML,
    // just enough to tell "new rows scrolled into view" from "same screen,
    // mid-scroll blur, or a pause". This adapts to any scroll speed without
    // a fixed frame-count guess, and kept frames feed into the exact same
    // per-image OCR pipeline screenshots already use.
    // The pure diff/downsampling math lives in gm-utils.js (window.GM.ocr*)
    // so it can be unit tested without a real <video>/<canvas>.
    var OCR_VIDEO_GRID_SIZE = 12;
    var OCR_VIDEO_FRAME_DIFF_RATIO = 0.06; // fraction of changed cells needed to keep a frame

    function ocrCaptureLuminanceGrid(gridCtx, video, gridSize) {
        gridCtx.drawImage(video, 0, 0, gridSize, gridSize);
        var data = gridCtx.getImageData(0, 0, gridSize, gridSize).data;
        var out = new Array(gridSize * gridSize);
        for (var i = 0, p = 0; i < data.length; i += 4, p++) {
            out[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
        }
        return out;
    }

    // Resolves to an array of JPEG Blobs (kept frames, in chronological
    // order). Rejects with Error.message one of: video_unsupported,
    // video_invalid, video_too_long, video_no_frames.
    function extractFramesFromVideo(file, opts) {
        opts = opts || {};
        var stepMs = opts.stepMs || 200;
        var maxDurationSec = opts.maxDurationSec || 480;
        var maxOutputWidth = opts.maxOutputWidth || 1600;
        var gridSize = OCR_VIDEO_GRID_SIZE;

        return new Promise(function (resolve, reject) {
            var video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            // 'metadata' (not 'auto'): all we need up front is duration/
            // dimensions — frames are pulled on demand by seeking, not by
            // sequential playback, so there's no reason to make the browser
            // eagerly buffer the entire file.
            video.preload = 'metadata';
            // Safari and Firefox are known to load/decode a video element
            // unreliably (or not at all) while it's fully detached from the
            // document — Chromium is lenient about this, which is why this
            // worked in testing but failed for real users on Safari/Firefox/
            // iOS regardless of the file's actual codec. Attach it off-screen
            // (not display:none, which some engines also deprioritize) so
            // every browser treats it as a normal, decodable element.
            video.style.cssText = 'position:fixed; left:-9999px; top:0; width:2px; height:2px; opacity:0.01; pointer-events:none;';
            video.setAttribute('aria-hidden', 'true');
            document.body.appendChild(video);
            var url = URL.createObjectURL(file);
            var settled = false;

            function cleanup() {
                URL.revokeObjectURL(url);
                video.removeAttribute('src');
                video.load();
                if (video.parentNode) video.parentNode.removeChild(video);
            }
            function fail(err) {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            }

            video.addEventListener('error', function () {
                // Surface the browser's actual MediaError (code + message) instead of
                // a bare "unsupported" — this is almost always a codec the browser
                // can't decode (e.g. HEVC/H.265 inside an otherwise valid MP4/MOV
                // container from an iPhone), not a corrupt or wrongly-named file, so
                // knowing the exact code matters for diagnosing it correctly.
                var mediaErr = video.error;
                var err = new Error('video_unsupported');
                err.mediaErrorCode = mediaErr ? mediaErr.code : null;
                err.mediaErrorMessage = mediaErr ? mediaErr.message : null;
                err.fileType = file.type || null;
                fail(err);
            });

            video.addEventListener('loadedmetadata', function () {
                var duration = video.duration;
                if (!isFinite(duration) || duration <= 0) { fail(new Error('video_invalid')); return; }
                if (duration > maxDurationSec) { fail(new Error('video_too_long')); return; }

                var vw = video.videoWidth, vh = video.videoHeight;
                if (!vw || !vh) { fail(new Error('video_invalid')); return; }

                var scale = Math.min(1, maxOutputWidth / vw);
                var outW = Math.max(1, Math.round(vw * scale));
                var outH = Math.max(1, Math.round(vh * scale));

                var canvas = document.createElement('canvas');
                canvas.width = outW; canvas.height = outH;
                var ctx = canvas.getContext('2d');

                var gridCanvas = document.createElement('canvas');
                gridCanvas.width = gridSize; gridCanvas.height = gridSize;
                var gridCtx = gridCanvas.getContext('2d', { willReadFrequently: true });

                function seekTo(t) {
                    return new Promise(function (res) {
                        function onSeeked() {
                            video.removeEventListener('seeked', onSeeked);
                            res();
                        }
                        video.addEventListener('seeked', onSeeked);
                        video.currentTime = t;
                    });
                }

                (async function walk() {
                    try {
                        var kept = [];
                        var lastGrid = null;
                        var steps = Math.max(1, Math.ceil((duration * 1000) / stepMs));

                        for (var s = 0; s <= steps; s++) {
                            var t = Math.min(duration, (s * stepMs) / 1000);
                            await seekTo(t);
                            var grid = ocrCaptureLuminanceGrid(gridCtx, video, gridSize);
                            var isEdge = (s === 0) || (t >= duration - 0.05);
                            var ratio = lastGrid ? window.GM.ocrGridDiffRatio(grid, lastGrid) : 1;
                            if (isEdge || ratio >= OCR_VIDEO_FRAME_DIFF_RATIO) {
                                ctx.drawImage(video, 0, 0, outW, outH);
                                var blob = await new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', 0.85); });
                                if (blob) kept.push(blob);
                                lastGrid = grid;
                            }
                            if (t >= duration) break;
                        }

                        if (settled) return;
                        settled = true;
                        cleanup();

                        if (kept.length === 0) { reject(new Error('video_no_frames')); return; }
                        resolve(kept);
                    } catch (err) {
                        fail(err);
                    }
                })();
            });

            video.src = url;
            video.load();
        });
    }

    async function handleOcrFiles(files) {
        var dropzone = document.getElementById('ocr-dropzone');
        var loading = document.getElementById('ocr-loading');
        var resultsContainer = document.getElementById('ocr-results-container');
        var loadingH4 = loading ? loading.querySelector('h4') : null;
        var loadingP = loading ? loading.querySelector('p') : null;

        var videoFiles = files.filter(function (f) { return f.type.indexOf('video/') === 0; });
        var imageFiles = files.filter(function (f) { return f.type.indexOf('image/') === 0; });
        if (imageFiles.length === 0 && videoFiles.length === 0) {
            showToast('Please select a valid image (PNG, JPG, WEBP) or video (MP4, MOV) file.', 'error');
            return;
        }

        if (dropzone) dropzone.style.display = 'none';
        if (loading) loading.style.display = 'block';
        if (resultsContainer) resultsContainer.style.display = 'none';

        // Turn each video into a set of frames (only where content actually
        // changed since the last kept one), then fold them in as if they
        // were additional screenshots — everything downstream is unchanged.
        if (videoFiles.length > 0) {
            if (loadingH4) loadingH4.textContent = 'Scanning video for new content...';
            for (var v = 0; v < videoFiles.length; v++) {
                if (loadingP) {
                    loadingP.textContent = videoFiles.length > 1
                        ? 'Extracting frames from video ' + (v + 1) + ' of ' + videoFiles.length + '...'
                        : 'Extracting frames from your video — this can take a moment...';
                }
                try {
                    var frameBlobs = await extractFramesFromVideo(videoFiles[v]);
                    imageFiles = imageFiles.concat(frameBlobs);
                } catch (err) {
                    console.error('Video frame extraction failed:', err, {
                        mediaErrorCode: err && err.mediaErrorCode,
                        mediaErrorMessage: err && err.mediaErrorMessage,
                        fileType: err && err.fileType
                    });
                    var msg = 'Could not process the video. Try an MP4/MOV recording, or use screenshots instead.';
                    if (err && err.message === 'video_too_long') {
                        msg = 'Video is too long (max 8 minutes) — trim it or use screenshots instead.';
                    } else if (err && err.message === 'video_unsupported') {
                        // MediaError 3 (decode) / 4 (src not supported) on an MP4/MOV
                        // from a phone has two realistic causes: an HEVC/H.265
                        // video stream the browser can't decode, or the browser
                        // (mobile Safari especially) hitting a decode/memory
                        // ceiling on a large, high-resolution recording. Name
                        // both — each has a different fix — rather than guessing.
                        var isDecodeFailure = (err.mediaErrorCode === 3 || err.mediaErrorCode === 4);
                        msg = isDecodeFailure
                            ? 'This browser couldn\'t decode the video — either its codec (e.g. HEVC/H.265) isn\'t supported, or it\'s too large/high-resolution to process. Try a shorter recording, re-export as H.264, or use screenshots instead.'
                            : 'This video format could not be read. Try MP4, or use screenshots instead.';
                    } else if (err && err.message === 'video_no_frames') {
                        msg = 'No distinct frames were found in that video.';
                    }
                    showToast(msg, 'error');
                    if (loading) loading.style.display = 'none';
                    if (dropzone) dropzone.style.display = 'block';
                    return;
                }
            }
        }

        if (imageFiles.length > 25) {
            showToast('Processing maximum 25 images per batch (200+ players).', 'info');
            imageFiles = window.GM.ocrDownsampleEvenly(imageFiles, 25);
        }

        var meta = OCR_METRICS_META[currentOcrMetric] || OCR_METRICS_META.power;
        var tagInput = document.getElementById('ocr-guild-tag-input');
        var activeGuildTag = (tagInput && tagInput.value.trim()) ? tagInput.value.trim() : ((window.GM && window.GM.getGuildTag) ? (await window.GM.getGuildTag()) : '');

        if (loadingH4) loadingH4.textContent = 'Analyzing screenshots with AI OCR (' + meta.header + ')...';

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

            // Rank context (R4/R3/R2/R1) carried from one batch into the next —
            // only meaningful for the Members metric; every other metric's
            // response simply never sets endingRank, so this stays null.
            var carryRank = null;

            for (var b = 0; b < chunks.length; b++) {
                var currentChunk = chunks[b];
                if (loadingP) {
                    loadingP.textContent = 'Processing screenshots batch ' + (b + 1) + ' of ' + chunks.length + ' (' + imageFiles.length + ' total images)...';
                }

                var batchResult = await callGeminiOcrBatchApi(currentChunk, currentOcrMetric, activeGuildTag, carryRank, function (statusMsg) {
                    if (loadingP) loadingP.textContent = statusMsg;
                });

                allPlayers = allPlayers.concat(batchResult.players);
                if (batchResult.endingRank) carryRank = batchResult.endingRank;

                if (b < chunks.length - 1) {
                    await new Promise(function (r) { setTimeout(r, 1200); });
                }
            }

            var uniqueMap = {};
            allPlayers.forEach(function (p) {
                if (!p || !p.pseudo) return;
                var cleanPseudo = (window.GM && window.GM.cleanPlayerPseudo) ? window.GM.cleanPlayerPseudo(p.pseudo, activeGuildTag) : p.pseudo.trim();
                var key = cleanPseudo.toLowerCase();
                var pScore = p.score != null ? p.score : (p.overall_power || 0);
                var prior = uniqueMap[key];
                if (!prior || (pScore && pScore > (prior.score || 0))) {
                    uniqueMap[key] = {
                        pseudo: cleanPseudo,
                        raw_pseudo: p.pseudo,
                        guild_tag: p.guild_tag || null,
                        score: pScore,
                        overall_power: pScore,
                        uid: p.uid || null,
                        // Keep whichever rank is known between the old and new
                        // sighting of this pseudo — a later duplicate frame
                        // without clear header context shouldn't erase a rank
                        // an earlier frame already established.
                        rank: p.rank || (prior && prior.rank) || null
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

    // rankHint carries the rank section (R4/R3/R2/R1) still in effect at the
    // end of the PREVIOUS batch, for the Members metric only — a rank header
    // ("Executive Manager", "Rank 3 Members", ...) can scroll out of view
    // partway through a recording, so without this hint the batch that
    // follows would have no way to know which section its players are still
    // under. Returns { players, endingRank } so the caller can chain it into
    // the next batch; endingRank is null/undefined for every other metric.
    async function callGeminiOcrBatchApi(batchImageItems, metricType, guildTag, rankHint, updateStatusCallback) {
        if (typeof guildTag === 'function') {
            updateStatusCallback = guildTag;
            rankHint = null;
            guildTag = '';
        } else if (typeof rankHint === 'function') {
            updateStatusCallback = rankHint;
            rankHint = null;
        }
        metricType = metricType || 'power';
        guildTag = guildTag || '';
        var db = (window.GM && window.GM.db) ? window.GM.db : null;

        if (!db || !db.functions) {
            throw new Error('OCR service unavailable. Please sign in and try again.');
        }

        if (updateStatusCallback) updateStatusCallback('Analyzing with AI OCR (' + metricType.toUpperCase() + (guildTag ? ' ' + guildTag : '') + ')...');
        var res = await db.functions.invoke('ocr-guild-members', {
            body: { images: batchImageItems, metricType: metricType, guildTag: guildTag, rankHint: rankHint || null }
        });

        if (res.data && res.data.ok && Array.isArray(res.data.players)) {
            return { players: res.data.players, endingRank: res.data.endingRank || null };
        }

        var errMsg = (res.data && res.data.error) || (res.error && res.error.message) || 'OCR analysis failed. Please try again.';
        throw new Error(errMsg);
    }

    var calculateStringSimilarity = (window.GM && window.GM.calculateStringSimilarity) ? window.GM.calculateStringSimilarity : function () { return 0; };
    var levenshteinDistance = (window.GM && window.GM.levenshteinDistance) ? window.GM.levenshteinDistance : function () { return 0; };
    var findBestMatchingMember = (window.GM && window.GM.findBestMatchingMember) ? window.GM.findBestMatchingMember : function () { return null; };
    var categorizeOcrDiff = (window.GM && window.GM.categorizeOcrDiff) ? window.GM.categorizeOcrDiff : function () { return { existing: [], new: [], removed: [] }; };
    var computeOcrRosterDelta = (window.GM && window.GM.computeOcrRosterDelta) ? window.GM.computeOcrRosterDelta : function (b, a, r) { return { before: b, after: b + a - r, added: a, removed: r }; };

    // Renders the Members-metric "Rank" cell: an editable R4/R3/R2/R1 select
    // pre-filled with the OCR-detected rank (defaulting to "keep the current
    // role" for an existing member, or "R1" for a brand new one, matching
    // commitOcrUpdates' own fallback so an untouched dropdown changes
    // nothing beyond what already happens today). R5 is never editable here
    // — same protection the manual bulk rank-assignment buttons already
    // enforce, since a scrolled roster shouldn't be able to touch the
    // guild leader's rank.
    function renderOcrRankCell(idx, detectedRank, currentRole) {
        var esc2 = (window.GM && window.GM.escapeHTML) ? window.GM.escapeHTML : function (s) { return String(s || ''); };
        if (currentRole === 'R5') {
            return '<td class="ocr-cell-rank"><span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3); font-size:0.72rem; white-space:nowrap;" title="R5 Leader is protected from bulk rank changes"><i class="ph ph-shield-star"></i> R5</span></td>';
        }
        var noChangeLabel = currentRole ? ('Keep (' + currentRole + ')') : 'R1 (default)';
        var opts = '<option value="">' + esc2(noChangeLabel) + '</option>';
        ['R4', 'R3', 'R2', 'R1'].forEach(function (r) {
            opts += '<option value="' + r + '"' + (detectedRank === r ? ' selected' : '') + '>' + r + '</option>';
        });
        return '<td class="ocr-cell-rank"><select class="ocr-edit-rank gm-input" data-index="' + idx + '" style="padding:0.2rem 0.35rem; font-size:0.78rem; font-weight:600; width:100%; max-width:118px;">' + opts + '</select></td>';
    }

    function renderOcrResults(players) {
        var loading = document.getElementById('ocr-loading');
        var resultsContainer = document.getElementById('ocr-results-container');
        var table = resultsContainer ? resultsContainer.querySelector('.ocr-table') : null;
        var tbody = document.getElementById('ocr-results-tbody');
        var tbodyNew = document.getElementById('ocr-results-tbody-new');
        var tbodyRemoved = document.getElementById('ocr-results-tbody-removed');
        var countSpan = document.getElementById('ocr-detected-count');
        var summaryBadges = document.getElementById('ocr-summary-badges');
        var btnCommit = document.getElementById('ocr-commit-btn');

        var esc = (window.GM && window.GM.escapeHTML) ? window.GM.escapeHTML : function (s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        };
        var fmtNum = (window.GM && window.GM.formatNumber) ? window.GM.formatNumber : function (n) {
            return String(n || 0);
        };

        var meta = OCR_METRICS_META[currentOcrMetric] || OCR_METRICS_META.power;
        var targetField = meta.field;
        var isMultiGuild = !!meta.isMultiGuild;
        var tagInput = document.getElementById('ocr-guild-tag-input');
        var activeGuildTag = (tagInput && tagInput.value.trim()) ? tagInput.value.trim() : '';

        if (loading) loading.style.display = 'none';
        if (resultsContainer) resultsContainer.style.display = 'block';
        if (btnCommit) btnCommit.style.display = 'inline-flex';

        if (countSpan) countSpan.textContent = players ? players.length : 0;

        if (!players || players.length === 0) {
            if (tbody) {
                var cs = meta.isEvent ? 4 : 5;
                tbody.innerHTML = '<tr><td colspan="' + cs + '" style="text-align:center; padding:2rem; color:var(--text-muted);"><i class="ph ph-warning-circle" style="font-size:1.5rem; display:block; margin-bottom:0.5rem; color:#facc15;"></i>No player usernames or ' + meta.header + ' values were detected in the uploaded image(s). Please try clearer screenshots.</td></tr>';
            }
            if (tbodyNew) tbodyNew.innerHTML = '';
            if (tbodyRemoved) tbodyRemoved.innerHTML = '';
            if (summaryBadges) {
                summaryBadges.innerHTML = '<span class="gm-chip" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);"><i class="ph ph-x-circle"></i> 0 Detected</span>';
            }
            updateCommitButtonCount();
            return;
        }

        var isEventOcr = !!meta.isEvent;

        if (isEventOcr) {
            if (table) {
                table.classList.add('ocr-table--event');
                table.classList.remove('ocr-table--roster');
            }
            if (tbodyNew) tbodyNew.innerHTML = '';
            if (tbodyRemoved) tbodyRemoved.innerHTML = '';

            var updateCount = 0;
            var reconciledCount = 0;
            var otherGuildCount = 0;

            var sfAssignments = [];
            if (meta.eventType === 'shadowfront' && window.GM_SHADOWFRONT && window.GM_SHADOWFRONT.getAssignments) {
                sfAssignments = window.GM_SHADOWFRONT.getAssignments();
            }

            var html = '';
            players.forEach(function (p, idx) {
                var matchRes = findBestMatchingMember(p.pseudo, guildMembers, activeGuildTag);
                var existing = matchRes ? matchRes.member : null;
                var matchType = matchRes ? matchRes.matchType : null;

                var cleanPseudo = (window.GM && window.GM.cleanPlayerPseudo) ? window.GM.cleanPlayerPseudo(p.pseudo, activeGuildTag) : p.pseudo.trim();
                var effectivePseudo = existing ? existing.pseudo : cleanPseudo;
                if (existing && (matchType === 'normalized' || matchType === 'fuzzy' || matchType === 'clean_tag') && p.pseudo !== existing.pseudo) {
                    effectivePseudo = existing.pseudo;
                    p.pseudo = existing.pseudo;
                    reconciledCount++;
                }

                var pScore = p.score != null ? p.score : (p.overall_power || 0);
                var badgeHtml = '';
                var isChecked = true;

                if (!existing) {
                    otherGuildCount++;
                    isChecked = false;
                    badgeHtml = '<span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-slash"></i> Other Guild / Non-Member</span>';
                } else if (meta.eventType === 'shadowfront') {
                    updateCount++;
                    var sfAssign = sfAssignments.find(function (a) { return a.pseudo && a.pseudo.toLowerCase() === existing.pseudo.toLowerCase(); });
                    if (sfAssign && sfAssign.role === 'reserve') {
                        badgeHtml = '<span class="gm-chip" style="background:rgba(168,85,247,0.15); color:#c084fc; border:1px solid rgba(168,85,247,0.3);"><i class="ph ph-clock-countdown"></i> Substitute &rarr; [Sub Present ✓] + [Participated ✓]</span>';
                    } else if (sfAssign && sfAssign.role === 'participant') {
                        badgeHtml = '<span class="gm-chip gm-chip-success"><i class="ph ph-shield-check"></i> Main Squad &rarr; [Participated ✓]</span>';
                    } else {
                        badgeHtml = '<span class="gm-chip gm-chip-warning"><i class="ph ph-warning"></i> Guild Member &rarr; [Participated ✓]</span>';
                    }
                } else if (currentOcrMetric === 'dtr') {
                    updateCount++;
                    if (pScore > 0) {
                        badgeHtml = '<span class="gm-chip gm-chip-success"><i class="ph ph-check-circle"></i> Score: ' + fmtNum(pScore) + ' &rarr; [Participated ✓]</span>';
                    } else {
                        badgeHtml = '<span class="gm-chip gm-chip-accent"><i class="ph ph-check-square"></i> Score: 0 &rarr; [Appointed ✓] + [Participated ✓]</span>';
                    }
                } else if (meta.eventType === 'armsrace') {
                    updateCount++;
                    badgeHtml = '<span class="gm-chip gm-chip-success"><i class="ph ph-check-circle"></i> Present &rarr; [Participated ✓]</span>';
                } else if (currentOcrMetric === 'svs_prep' || currentOcrMetric === 'gvg_prep') {
                    updateCount++;
                    badgeHtml = '<span class="gm-chip" style="background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3);"><i class="ph ph-sword"></i> Prep Score: ' + fmtNum(pScore) + ' &rarr; [Participated ✓]</span>';
                } else if (currentOcrMetric === 'svs_pvp' || currentOcrMetric === 'gvg_pvp') {
                    updateCount++;
                    badgeHtml = '<span class="gm-chip" style="background:rgba(249,115,22,0.15); color:#f97316; border:1px solid rgba(249,115,22,0.3);"><i class="ph ph-fire"></i> PvP Score: ' + fmtNum(pScore) + ' &rarr; [Participated ✓]</span>';
                } else {
                    updateCount++;
                    badgeHtml = '<span class="gm-chip gm-chip-success"><i class="ph ph-check"></i> ' + meta.header + ': ' + fmtNum(pScore) + ' &rarr; [Participated ✓]</span>';
                }

                var metricLabel = meta.header || 'Score';
                html += '<tr class="ocr-row" data-pseudo="' + esc(effectivePseudo.toLowerCase()) + '">' +
                    '<td class="ocr-cell-check" style="text-align: center;"><input type="checkbox" class="ocr-row-cb" data-index="' + idx + '" ' + (isChecked ? 'checked' : '') + '></td>' +
                    '<td class="ocr-cell-pseudo"><input type="text" class="ocr-edit-pseudo gm-input" data-index="' + idx + '" value="' + esc(effectivePseudo) + '" placeholder="Player Username" style="padding:0.25rem 0.5rem; font-size:0.85rem; font-weight:600; width:100%; max-width:180px;"></td>' +
                    '<td class="ocr-cell-metric">' +
                        '<span class="ocr-metric-label"><i class="ph ' + (meta.icon || 'ph-hash') + '"></i> ' + esc(metricLabel) + ':</span>' +
                        '<input type="number" class="ocr-edit-power gm-input" data-index="' + idx + '" value="' + pScore + '" style="padding:0.25rem 0.5rem; font-size:0.85rem; font-weight:600; color:' + meta.color + '; width:100%; max-width:140px;">' +
                    '</td>' +
                    '<td class="ocr-cell-status">' + badgeHtml + '</td>' +
                '</tr>';
            });

            if (summaryBadges) {
                summaryBadges.innerHTML = 
                    '<span class="gm-chip" style="background:rgba(99,102,241,0.15); color:#818cf8; border:1px solid rgba(99,102,241,0.3);"><i class="ph ph-arrows-clockwise"></i> ' + updateCount + ' Ready to Apply</span>' +
                    (reconciledCount > 0 ? '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-sparkle"></i> ' + reconciledCount + ' Reconciled</span>' : '') +
                    (otherGuildCount > 0 ? '<span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-slash"></i> ' + otherGuildCount + ' Ignored / Non-Tenant</span>' : '');
            }

            if (tbody) tbody.innerHTML = html;
        } else {
            // ── Roster & Metric Scanners Review ──
            if (table) {
                table.classList.add('ocr-table--roster');
                table.classList.remove('ocr-table--event');
            }

            var isMembersMode = (currentOcrMetric === 'members');
            var diff = categorizeOcrDiff(players, guildMembers, activeGuildTag, targetField, isMultiGuild, isMembersMode ? 'members' : 'metric');
            var metricLabel = meta.header || 'Score';

            // 1. Existing Members Section
            var existingHtml = '';
            if (diff.existing.length > 0) {
                existingHtml += '<tr class="ocr-section-header ocr-section-header--existing"><td colspan="' + (isMembersMode ? 6 : 5) + '"><div class="ocr-section-title"><i class="ph ph-users"></i> Existing Members <span class="gm-badge">' + diff.existing.length + '</span></div></td></tr>';
                diff.existing.forEach(function (item) {
                    var idx = item.index;
                    var effPseudo = item.effectivePseudo;
                    var pScore = item.newVal;
                    var currentVal = item.currentVal;
                    var uid = item.uid || (item.member ? item.member.uid : '') || '';

                    var badgeHtml = '';
                    if (item.status === 'reconciled') {
                        badgeHtml = '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-sparkle"></i> Reconciled ("' + esc(item.member.pseudo) + '") &rarr; ' + fmtNum(pScore) + '</span>';
                    } else if (item.status === 'update') {
                        badgeHtml = '<span class="gm-chip" style="background:rgba(99,102,241,0.15); color:' + meta.color + '; border:1px solid rgba(99,102,241,0.3);"><i class="ph ph-arrows-clockwise"></i> Update (' + fmtNum(currentVal) + ' &rarr; ' + fmtNum(pScore) + ')</span>';
                    } else {
                        badgeHtml = '<span class="gm-chip" style="background:rgba(255,255,255,0.05); color:var(--text-muted);"><i class="ph ph-check"></i> Unchanged</span>';
                    }

                    existingHtml += '<tr class="ocr-row ocr-row--existing" data-pseudo="' + esc(effPseudo.toLowerCase()) + '">' +
                        '<td class="ocr-cell-check" style="text-align: center;"><input type="checkbox" class="ocr-row-cb" data-index="' + idx + '" data-section="existing" checked></td>' +
                        '<td class="ocr-cell-pseudo"><input type="text" class="ocr-edit-pseudo gm-input" data-index="' + idx + '" value="' + esc(effPseudo) + '" placeholder="Player Username" style="padding:0.25rem 0.5rem; font-size:0.85rem; font-weight:600; width:100%; max-width:180px;"></td>' +
                        '<td class="ocr-cell-uid"><span class="ocr-readonly-uid">' + esc(uid || '—') + '</span></td>' +
                        (isMembersMode ? renderOcrRankCell(idx, item.ocrPlayer && item.ocrPlayer.rank, item.member && item.member.role) : '') +
                        '<td class="ocr-cell-metric">' +
                            '<span class="ocr-metric-label"><i class="ph ' + (meta.icon || 'ph-hash') + '"></i> ' + esc(metricLabel) + ':</span>' +
                            '<input type="number" class="ocr-edit-power gm-input" data-index="' + idx + '" value="' + pScore + '" style="padding:0.25rem 0.5rem; font-size:0.85rem; font-weight:600; color:' + meta.color + '; width:100%; max-width:140px;">' +
                        '</td>' +
                        '<td class="ocr-cell-status">' + badgeHtml + '</td>' +
                    '</tr>';
                });
            }
            if (tbody) tbody.innerHTML = existingHtml;

            // 2. Section 2: New Members (in members mode) OR Not in Roster (in metric mode)
            var newHtml = '';
            if (isMembersMode) {
                if (diff.new.length > 0) {
                    newHtml += '<tr class="ocr-section-header ocr-section-header--new"><td colspan="6"><div class="ocr-section-title"><i class="ph ph-user-plus"></i> New Members <span class="gm-badge">' + diff.new.length + '</span></div></td></tr>';
                    diff.new.forEach(function (item) {
                        var idx = item.index;
                        var effPseudo = item.effectivePseudo;
                        var pScore = item.newVal;
                        var uid = item.uid || (item.ocrPlayer ? item.ocrPlayer.uid : '') || '';
                        var isOtherGuild = item.status === 'other_guild';
                        var isChecked = !isOtherGuild;
                        var uidStat = window.GM && window.GM.getUidStatus ? window.GM.getUidStatus(uid) : { valid: true };
                        var uidInputStyle = !uidStat.valid
                            ? 'padding:0.25rem 0.5rem; font-size:0.8rem; width:100%; max-width:120px; border-color:rgba(239,68,68,0.7); background:rgba(239,68,68,0.06);'
                            : 'padding:0.25rem 0.5rem; font-size:0.8rem; width:100%; max-width:120px;';

                        var badgeHtml = isOtherGuild
                            ? '<span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-slash"></i> Other Guild (Unchecked)</span>'
                            : '<span class="gm-chip gm-chip-success"><i class="ph ph-user-plus"></i> New Player</span>';

                        newHtml += '<tr class="ocr-row ocr-row--new" data-pseudo="' + esc(effPseudo.toLowerCase()) + '">' +
                            '<td class="ocr-cell-check" style="text-align: center;"><input type="checkbox" class="ocr-row-cb" data-index="' + idx + '" data-section="new" ' + (isChecked ? 'checked' : '') + '></td>' +
                            '<td class="ocr-cell-pseudo"><input type="text" class="ocr-edit-pseudo gm-input" data-index="' + idx + '" value="' + esc(effPseudo) + '" placeholder="Player Username" style="padding:0.25rem 0.5rem; font-size:0.85rem; font-weight:600; width:100%; max-width:180px;"></td>' +
                            '<td class="ocr-cell-uid"><input type="text" class="ocr-edit-uid gm-input" data-index="' + idx + '" value="' + esc(uid) + '" placeholder="TEMP (auto)" style="' + uidInputStyle + '"></td>' +
                            renderOcrRankCell(idx, item.ocrPlayer && item.ocrPlayer.rank, null) +
                            '<td class="ocr-cell-metric">' +
                                '<span class="ocr-metric-label"><i class="ph ' + (meta.icon || 'ph-hash') + '"></i> ' + esc(metricLabel) + ':</span>' +
                                '<input type="number" class="ocr-edit-power gm-input" data-index="' + idx + '" value="' + pScore + '" style="padding:0.25rem 0.5rem; font-size:0.85rem; font-weight:600; color:' + meta.color + '; width:100%; max-width:140px;">' +
                            '</td>' +
                            '<td class="ocr-cell-status">' + badgeHtml + '</td>' +
                        '</tr>';
                    });
                }
            } else {
                // Metric Mode: Unknown / Unmatched players displayed as "Not in Roster" (read-only, unchecked, disabled)
                if (diff.unknown && diff.unknown.length > 0) {
                    newHtml += '<tr class="ocr-section-header ocr-section-header--unknown"><td colspan="5"><div class="ocr-section-title" style="color:#fbbf24;"><i class="ph ph-user-focus"></i> Not in Roster <span class="gm-badge" style="background:rgba(245,158,11,0.2); color:#fbbf24;">' + diff.unknown.length + '</span></div></td></tr>';
                    diff.unknown.forEach(function (item) {
                        var effPseudo = item.effectivePseudo;
                        var pScore = item.newVal;

                        newHtml += '<tr class="ocr-row ocr-row--unknown" data-pseudo="' + esc(effPseudo.toLowerCase()) + '">' +
                            '<td class="ocr-cell-check" style="text-align: center;"><input type="checkbox" class="ocr-row-cb" disabled style="opacity:0.4; cursor:not-allowed;"></td>' +
                            '<td class="ocr-cell-pseudo"><span style="font-weight:600; color:var(--text-muted);">' + esc(effPseudo) + '</span></td>' +
                            '<td class="ocr-cell-uid"><span class="ocr-readonly-uid">—</span></td>' +
                            '<td class="ocr-cell-metric">' +
                                '<span class="ocr-metric-label"><i class="ph ' + (meta.icon || 'ph-hash') + '"></i> ' + esc(metricLabel) + ':</span>' +
                                '<span style="font-size:0.85rem; font-weight:600; color:var(--text-muted);">' + fmtNum(pScore) + '</span>' +
                            '</td>' +
                            '<td class="ocr-cell-status"><span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-warning"></i> Use Members OCR to add</span></td>' +
                        '</tr>';
                    });
                }
            }
            if (tbodyNew) tbodyNew.innerHTML = newHtml;

            // 3. Removed Members Section (Members mode only)
            var removedHtml = '';
            if (isMembersMode && diff.removed.length > 0) {
                if (guildMembers.length > 0 && diff.removed.length > guildMembers.length * 0.5) {
                    removedHtml += '<tr class="ocr-warning-row"><td colspan="5"><div class="ocr-removed-warning" style="background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.3); color:#fbbf24; padding:0.5rem 0.75rem; border-radius:6px; margin:0.35rem 0; font-size:0.78rem; display:flex; align-items:center; gap:0.4rem;"><i class="ph ph-warning" style="font-size:1.1rem; flex-shrink:0;"></i><span>More than half your roster would be removed. If this screenshot is partial, uncheck the members to keep.</span></div></td></tr>';
                }
                removedHtml += '<tr class="ocr-section-header ocr-section-header--removed"><td colspan="5"><div style="display:flex; justify-content:space-between; align-items:center; width:100%;"><div class="ocr-section-title"><i class="ph ph-user-minus"></i> Removed Members <span class="gm-badge gm-badge--danger">' + diff.removed.length + '</span></div><div style="font-size:0.75rem; color:var(--text-muted);"><button type="button" class="gm-btn-text" id="ocr-btn-keep-all" style="font-size:0.75rem; color:var(--accent); cursor:pointer; background:none; border:none; padding:0 0.4rem;">Keep All</button> | <button type="button" class="gm-btn-text" id="ocr-btn-remove-all" style="font-size:0.75rem; color:#f87171; cursor:pointer; background:none; border:none; padding:0 0.4rem;">Remove All</button></div></div></td></tr>';

                diff.removed.forEach(function (item) {
                    var m = item.member;
                    var pseudo = item.pseudo;
                    var uid = item.uid || '';
                    var role = item.role || 'R1';
                    var power = item.currentPower || 0;

                    removedHtml += '<tr class="ocr-row ocr-row--removed" data-pseudo="' + esc(pseudo.toLowerCase()) + '" data-removal-pseudo="' + esc(pseudo) + '">' +
                        '<td class="ocr-cell-check" style="text-align: center;"><input type="checkbox" class="ocr-row-cb ocr-removal-cb" data-removal-pseudo="' + esc(pseudo) + '" data-section="removed" checked></td>' +
                        '<td class="ocr-cell-pseudo"><span style="font-weight:600; color:var(--text-muted);">' + esc(pseudo) + '</span> <span class="gm-role-badge" style="font-size:0.7rem; padding:0.1rem 0.3rem;">' + esc(role) + '</span></td>' +
                        '<td class="ocr-cell-uid"><span class="ocr-readonly-uid">' + esc(uid || '—') + '</span></td>' +
                        '<td class="ocr-cell-metric"><span style="color:var(--text-muted); font-size:0.85rem;"><i class="ph ' + (meta.icon || 'ph-hash') + '"></i> ' + fmtNum(power) + '</span></td>' +
                        '<td class="ocr-cell-status"><span class="ocr-removal-status-wrap"><span class="gm-chip ocr-chip-removal" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);"><i class="ph ph-user-minus"></i> To Remove</span></span></td>' +
                    '</tr>';
                });
            }
            if (tbodyRemoved) tbodyRemoved.innerHTML = removedHtml;
        }

        // Bind interactive event listeners
        if (resultsContainer) {
            resultsContainer.querySelectorAll('.ocr-row-cb:not(.ocr-removal-cb)').forEach(function (cb) {
                cb.addEventListener('change', updateCommitButtonCount);
            });

            resultsContainer.querySelectorAll('.ocr-removal-cb').forEach(function (cb) {
                cb.addEventListener('change', function () {
                    var row = cb.closest('tr');
                    var wrap = row ? row.querySelector('.ocr-removal-status-wrap') : null;
                    if (wrap) {
                        if (cb.checked) {
                            wrap.innerHTML = '<span class="gm-chip ocr-chip-removal" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);"><i class="ph ph-user-minus"></i> To Remove</span>';
                        } else {
                            wrap.innerHTML = '<span class="gm-chip ocr-chip-kept" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-check"></i> Kept</span>';
                        }
                    }
                    updateCommitButtonCount();
                });
            });

            resultsContainer.querySelectorAll('.ocr-edit-pseudo').forEach(function (input) {
                input.addEventListener('input', function () {
                    var idx = parseInt(input.getAttribute('data-index'), 10);
                    if (ocrExtractedPlayers[idx]) {
                        ocrExtractedPlayers[idx].pseudo = input.value.trim();
                    }
                    var row = input.closest('tr');
                    if (row) {
                        row.setAttribute('data-pseudo', input.value.trim().toLowerCase());
                    }
                });
            });

            resultsContainer.querySelectorAll('.ocr-edit-power').forEach(function (input) {
                input.addEventListener('input', function () {
                    var idx = parseInt(input.getAttribute('data-index'), 10);
                    if (ocrExtractedPlayers[idx]) {
                        var val = parseInt(input.value, 10) || 0;
                        ocrExtractedPlayers[idx].score = val;
                        ocrExtractedPlayers[idx].overall_power = val;
                    }
                });
            });

            resultsContainer.querySelectorAll('.ocr-edit-rank').forEach(function (select) {
                select.addEventListener('change', function () {
                    var idx = parseInt(select.getAttribute('data-index'), 10);
                    if (ocrExtractedPlayers[idx]) {
                        ocrExtractedPlayers[idx].rank = select.value || null;
                    }
                });
            });

            resultsContainer.querySelectorAll('.ocr-edit-uid').forEach(function (input) {
                input.addEventListener('input', function () {
                    var idx = parseInt(input.getAttribute('data-index'), 10);
                    var val = input.value.trim();
                    if (ocrExtractedPlayers[idx]) {
                        ocrExtractedPlayers[idx].uid = val;
                    }
                    var err = (window.GM && window.GM.validateUid) ? window.GM.validateUid(val) : null;
                    if (err) {
                        input.classList.add('gm-input-error');
                        input.style.borderColor = '#ef4444';
                    } else {
                        input.classList.remove('gm-input-error');
                        input.style.borderColor = '';
                    }
                });
            });

            var btnKeepAll = document.getElementById('ocr-btn-keep-all');
            if (btnKeepAll) {
                btnKeepAll.addEventListener('click', function () {
                    if (tbodyRemoved) {
                        tbodyRemoved.querySelectorAll('.ocr-removal-cb').forEach(function (cb) {
                            cb.checked = false;
                            var row = cb.closest('tr');
                            var wrap = row ? row.querySelector('.ocr-removal-status-wrap') : null;
                            if (wrap) {
                                wrap.innerHTML = '<span class="gm-chip ocr-chip-kept" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-check"></i> Kept</span>';
                            }
                        });
                        updateCommitButtonCount();
                    }
                });
            }

            var btnRemoveAll = document.getElementById('ocr-btn-remove-all');
            if (btnRemoveAll) {
                btnRemoveAll.addEventListener('click', function () {
                    if (tbodyRemoved) {
                        tbodyRemoved.querySelectorAll('.ocr-removal-cb').forEach(function (cb) {
                            cb.checked = true;
                            var row = cb.closest('tr');
                            var wrap = row ? row.querySelector('.ocr-removal-status-wrap') : null;
                            if (wrap) {
                                wrap.innerHTML = '<span class="gm-chip ocr-chip-removal" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);"><i class="ph ph-user-minus"></i> To Remove</span>';
                            }
                        });
                        updateCommitButtonCount();
                    }
                });
            }
        }

        var filterSearch = document.getElementById('ocr-filter-search');
        if (filterSearch) {
            filterSearch.value = '';
            filterSearch.oninput = function () {
                var query = filterSearch.value.trim().toLowerCase();
                var rows = resultsContainer ? resultsContainer.querySelectorAll('.ocr-row') : [];
                rows.forEach(function (row) {
                    var pseudoInput = row.querySelector('.ocr-edit-pseudo');
                    var pseudo = pseudoInput ? pseudoInput.value.toLowerCase() : (row.getAttribute('data-pseudo') || '');
                    if (!query || pseudo.indexOf(query) !== -1) {
                        row.style.display = '';
                    } else {
                        row.style.display = 'none';
                    }
                });
            };
        }

        updateCommitButtonCount();
    }

    function toggleAllCheckboxes(checked) {
        var tbodyExisting = document.getElementById('ocr-results-tbody');
        var tbodyNew = document.getElementById('ocr-results-tbody-new');
        [tbodyExisting, tbodyNew].forEach(function (tb) {
            if (!tb) return;
            tb.querySelectorAll('.ocr-row-cb').forEach(function (cb) {
                var row = cb.closest('tr');
                if (!row || row.style.display !== 'none') {
                    cb.checked = checked;
                }
            });
        });
        updateCommitButtonCount();
    }

    function updateCommitButtonCount() {
        var btnCommit = document.getElementById('ocr-commit-btn');
        var tbody = document.getElementById('ocr-results-tbody');
        var tbodyNew = document.getElementById('ocr-results-tbody-new');
        var tbodyRemoved = document.getElementById('ocr-results-tbody-removed');
        var summaryBadges = document.getElementById('ocr-summary-badges');
        if (!btnCommit) return;

        var meta = OCR_METRICS_META[currentOcrMetric] || OCR_METRICS_META.power;
        var isEventOcr = !!meta.isEvent;

        if (isEventOcr) {
            var selectedCbs = tbody ? tbody.querySelectorAll('.ocr-row-cb:checked') : [];
            var count = selectedCbs.length;
            var span = btnCommit.querySelector('span');
            if (span) span.textContent = 'Validate & Apply ' + meta.header + ' (' + count + ')';
            btnCommit.disabled = count === 0;
        } else if (currentOcrMetric === 'members') {
            var selectedExisting = tbody ? tbody.querySelectorAll('.ocr-row-cb:checked').length : 0;
            var selectedNew = tbodyNew ? tbodyNew.querySelectorAll('.ocr-row-cb:checked').length : 0;
            var checkedRemovals = tbodyRemoved ? tbodyRemoved.querySelectorAll('.ocr-removal-cb:checked').length : 0;
            var totalCount = selectedExisting + selectedNew + checkedRemovals;

            var span = btnCommit.querySelector('span');
            if (span) span.textContent = 'Validate & Apply Updates (' + totalCount + ')';
            btnCommit.disabled = totalCount === 0;

            if (summaryBadges) {
                var delta = computeOcrRosterDelta(guildMembers.length, selectedNew, checkedRemovals);
                var activeGuildTag = (document.getElementById('ocr-guild-tag-input') && document.getElementById('ocr-guild-tag-input').value.trim()) ? document.getElementById('ocr-guild-tag-input').value.trim() : '';
                var diff = categorizeOcrDiff(ocrExtractedPlayers, guildMembers, activeGuildTag, meta.field, meta.isMultiGuild, 'members');

                var newCount = diff.new.filter(function (n) { return n.status === 'new'; }).length;
                var updateCount = diff.existing.filter(function (e) { return e.status === 'update'; }).length;
                var reconciledCount = diff.existing.filter(function (e) { return e.status === 'reconciled'; }).length;
                var otherGuildCount = diff.new.filter(function (n) { return n.status === 'other_guild'; }).length;
                var unchangedCount = diff.existing.filter(function (e) { return e.status === 'unchanged'; }).length;
                var removalCount = diff.removed.length;

                summaryBadges.innerHTML =
                    '<span class="gm-chip gm-chip-accent" style="font-weight:700;"><i class="ph ph-users-three"></i> Roster: ' + delta.before + ' &rarr; ' + delta.after + '</span>' +
                    (newCount > 0 ? '<span class="gm-chip gm-chip-success"><i class="ph ph-user-plus"></i> ' + newCount + ' New</span>' : '') +
                    (updateCount > 0 ? '<span class="gm-chip" style="background:rgba(99,102,241,0.15); color:#818cf8; border:1px solid rgba(99,102,241,0.3);"><i class="ph ph-arrows-clockwise"></i> ' + updateCount + ' Updates</span>' : '') +
                    (reconciledCount > 0 ? '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-sparkle"></i> ' + reconciledCount + ' Reconciled</span>' : '') +
                    (removalCount > 0 ? '<span class="gm-chip" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);"><i class="ph ph-user-minus"></i> ' + removalCount + ' Removed</span>' : '') +
                    (otherGuildCount > 0 ? '<span class="gm-chip" style="background:rgba(100,116,139,0.15); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);"><i class="ph ph-shield-slash"></i> ' + otherGuildCount + ' Other Guild (Unchecked)</span>' : '') +
                    '<span class="gm-chip" style="background:rgba(255,255,255,0.05); color:var(--text-muted);"><i class="ph ph-check"></i> ' + unchangedCount + ' Unchanged</span>';
            }
        } else {
            // Metric Mode (update-only)
            var selectedExisting = tbody ? tbody.querySelectorAll('.ocr-row-cb:checked').length : 0;
            var span = btnCommit.querySelector('span');
            if (span) span.textContent = 'Validate & Apply ' + meta.header + ' (' + selectedExisting + ')';
            btnCommit.disabled = selectedExisting === 0;

            if (summaryBadges) {
                var activeGuildTag = (document.getElementById('ocr-guild-tag-input') && document.getElementById('ocr-guild-tag-input').value.trim()) ? document.getElementById('ocr-guild-tag-input').value.trim() : '';
                var diff = categorizeOcrDiff(ocrExtractedPlayers, guildMembers, activeGuildTag, meta.field, meta.isMultiGuild, 'metric');

                var updateCount = diff.existing.filter(function (e) { return e.status === 'update'; }).length;
                var reconciledCount = diff.existing.filter(function (e) { return e.status === 'reconciled'; }).length;
                var unchangedCount = diff.existing.filter(function (e) { return e.status === 'unchanged'; }).length;
                var unknownCount = diff.unknown ? diff.unknown.length : 0;

                summaryBadges.innerHTML =
                    '<span class="gm-chip" style="background:rgba(255,255,255,0.05); color:var(--text-muted); font-weight:600;"><i class="ph ph-users"></i> Roster: ' + guildMembers.length + ' (unchanged)</span>' +
                    (updateCount > 0 ? '<span class="gm-chip" style="background:rgba(99,102,241,0.15); color:#818cf8; border:1px solid rgba(99,102,241,0.3);"><i class="ph ph-arrows-clockwise"></i> ' + updateCount + ' Updates</span>' : '') +
                    (reconciledCount > 0 ? '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-sparkle"></i> ' + reconciledCount + ' Reconciled</span>' : '') +
                    (unknownCount > 0 ? '<span class="gm-chip" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3);"><i class="ph ph-warning"></i> ' + unknownCount + ' Not in Roster</span>' : '') +
                    '<span class="gm-chip" style="background:rgba(255,255,255,0.05); color:var(--text-muted);"><i class="ph ph-check"></i> ' + unchangedCount + ' Unchanged</span>';
            }
        }
    }

    async function commitOcrUpdates() {
        var tbody = document.getElementById('ocr-results-tbody');
        var tbodyNew = document.getElementById('ocr-results-tbody-new');
        var tbodyRemoved = document.getElementById('ocr-results-tbody-removed');
        var btnCommit = document.getElementById('ocr-commit-btn');
        if (!btnCommit) return;

        var meta = OCR_METRICS_META[currentOcrMetric] || OCR_METRICS_META.power;
        var targetField = meta.field;

        var esc = (window.GM && window.GM.escapeHTML) ? window.GM.escapeHTML : function (s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        };

        if (meta.isEvent) {
            // ── Event OCR Commit Handling (Branch A - Untouched) ──────
            if (!tbody) return;
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
                var db = (window.GM && window.GM.db) ? window.GM.db : supabase;
                var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';

                if (meta.eventType === 'shadowfront') {
                    var sqName = meta.squad === 'squad1' ? 'Shadowfront Squad 1' : 'Shadowfront Squad 2';
                    var sqRes = await db.from('event_status')
                        .select('session_id, is_active, start_at')
                        .eq('guild', currentG)
                        .eq('event_name', sqName)
                        .maybeSingle();

                    if (!sqRes.data || !sqRes.data.is_active || !sqRes.data.session_id) {
                        showToast('Please start the ' + (meta.squad === 'squad1' ? 'Squad 1' : 'Squad 2') + ' session in Events before applying OCR updates.', 'error');
                        btnCommit.disabled = false;
                        if (span) span.textContent = 'Validate & Apply Updates';
                        return;
                    }

                    var activeSid = sqRes.data.session_id;

                    var assignRes = await db.from('shadowfront_squads')
                        .select('pseudo, role, squad')
                        .eq('guild', currentG)
                        .eq('session_id', activeSid);
                    var sfAssignments = assignRes.data || [];
                    var assignMap = {};
                    sfAssignments.forEach(function (a) { assignMap[a.pseudo.toLowerCase()] = a.role; });

                    await window.GM.runInChunks(selectedPlayers, 10, async function (sp) {
                        var role = assignMap[sp.pseudo.toLowerCase()];
                        var updatePayload = {
                            participated: 1
                        };
                        if (role === 'reserve') {
                            updatePayload.sub_present = true;
                        }

                        var upRes = await db.from('event_participants')
                            .update(updatePayload)
                            .eq('guild', currentG)
                            .eq('event_name', 'Shadowfront')
                            .eq('session_id', activeSid)
                            .eq('pseudo', sp.pseudo)
                            .select('pseudo');

                        if (upRes.data && upRes.data.length === 0) {
                            var insertPayload = Object.assign({
                                guild: currentG,
                                event_name: 'Shadowfront',
                                session_id: activeSid,
                                pseudo: sp.pseudo,
                                week_start: window.GM.getWeekStart(sqRes.data.start_at || new Date())
                            }, updatePayload);
                            await db.from('event_participants').insert([insertPayload]);
                        }
                    });

                    if (window.GM_SHADOWFRONT && window.GM_SHADOWFRONT.load) {
                        await window.GM_SHADOWFRONT.load();
                    }
                } else if (meta.eventType === 'armsrace') {
                    var arEvName = meta.stage === 'stageA' ? 'ARMS RACE STAGE A' : 'ARMS RACE STAGE B';
                    var arRes = await db.from('event_status')
                        .select('session_id, is_active, start_at')
                        .eq('guild', currentG)
                        .eq('event_name', arEvName)
                        .maybeSingle();

                    if (!arRes.data || !arRes.data.is_active || !arRes.data.session_id) {
                        showToast('Please start Arms Race ' + (meta.stage === 'stageA' ? 'Stage A' : 'Stage B') + ' session in Events before applying OCR updates.', 'error');
                        btnCommit.disabled = false;
                        if (span) span.textContent = 'Validate & Apply Updates';
                        return;
                    }

                    var arSid = arRes.data.session_id;

                    await window.GM.runInChunks(selectedPlayers, 10, async function (sp) {
                        var upRes = await db.from('event_participants')
                            .update({ participated: 1 })
                            .eq('guild', currentG)
                            .eq('event_name', arEvName)
                            .eq('session_id', arSid)
                            .eq('pseudo', sp.pseudo)
                            .select('pseudo');

                        if (upRes.data && upRes.data.length === 0) {
                            await db.from('event_participants').insert([{
                                guild: currentG,
                                event_name: arEvName,
                                session_id: arSid,
                                pseudo: sp.pseudo,
                                participated: 1,
                                week_start: window.GM.getWeekStart(arRes.data.start_at || new Date())
                            }]);
                        }
                    });

                    if (window.GM_ARMSRACE && window.GM_ARMSRACE.load) {
                        await window.GM_ARMSRACE.load();
                    }
                } else {
                    var evName = meta.eventKey;
                    var evRes = await db.from('event_status')
                        .select('session_id, is_active, start_at')
                        .eq('guild', currentG)
                        .eq('event_name', evName)
                        .maybeSingle();

                    if (!evRes.data || !evRes.data.is_active || !evRes.data.session_id) {
                        showToast('Please start the ' + evName + ' session in Events before applying OCR updates.', 'error');
                        btnCommit.disabled = false;
                        if (span) span.textContent = 'Validate & Apply Updates';
                        return;
                    }

                    var evSid = evRes.data.session_id;

                    await window.GM.runInChunks(selectedPlayers, 10, async function (sp) {
                        var scoreVal = sp.score != null ? sp.score : 0;
                        var updatePayload = {};

                        if (currentOcrMetric === 'svs_prep' || currentOcrMetric === 'gvg_prep') {
                            updatePayload.score_prep = scoreVal;
                            updatePayload.participated = 1;
                        } else if (currentOcrMetric === 'svs_pvp' || currentOcrMetric === 'gvg_pvp') {
                            updatePayload.score_pvp = scoreVal;
                            updatePayload.participated = 1;
                        } else if (currentOcrMetric === 'dtr') {
                            if (scoreVal > 0) {
                                updatePayload.participated = 1;
                            } else {
                                updatePayload.appointed = true;
                                updatePayload.participated = 1;
                            }
                        }

                        var upRes = await db.from('event_participants')
                            .update(updatePayload)
                            .eq('guild', currentG)
                            .eq('event_name', evName)
                            .eq('session_id', evSid)
                            .eq('pseudo', sp.pseudo)
                            .select('pseudo');

                        if (upRes.data && upRes.data.length === 0) {
                            var insertPayload = Object.assign({
                                guild: currentG,
                                event_name: evName,
                                session_id: evSid,
                                pseudo: sp.pseudo,
                                week_start: window.GM.getWeekStart(evRes.data.start_at || new Date())
                            }, updatePayload);
                            await db.from('event_participants').insert([insertPayload]);
                        }
                    });

                    if (window.GM_EVENTS && window.GM_EVENTS.loadEvent) {
                        await window.GM_EVENTS.loadEvent(evName);
                    }
                }

                showToast(selectedPlayers.length + ' participant(s) updated for ' + meta.header + '!', 'success');
                if (window.GM && window.GM.cache) window.GM.cache.invalidate();
                var modal = document.getElementById('ocr-modal-overlay');
                if (modal) {
                    modal.classList.remove('visible');
                    modal.style.display = 'none';
                }
            } catch (err) {
                console.error('Commit Event OCR error:', err);
                showToast('Failed to save event OCR updates: ' + (err.message || err), 'error');
            } finally {
                btnCommit.disabled = false;
                var finalSpan = btnCommit.querySelector('span');
                if (finalSpan) finalSpan.textContent = 'Validate & Apply Updates';
            }
            return;
        }

        // ── Roster Metrics Commit Handling (Branch B) ─────────────
        var selectedExistingIndices = [];
        if (tbody) {
            tbody.querySelectorAll('.ocr-row-cb:checked').forEach(function (cb) {
                selectedExistingIndices.push(parseInt(cb.getAttribute('data-index'), 10));
            });
        }

        var selectedNewIndices = [];
        if (tbodyNew) {
            tbodyNew.querySelectorAll('.ocr-row-cb:checked').forEach(function (cb) {
                selectedNewIndices.push(parseInt(cb.getAttribute('data-index'), 10));
            });
        }

        var checkedRemovalPseudos = [];
        if (tbodyRemoved) {
            tbodyRemoved.querySelectorAll('.ocr-removal-cb:checked').forEach(function (cb) {
                var p = cb.getAttribute('data-removal-pseudo');
                if (p) checkedRemovalPseudos.push(p);
            });
        }

        if (selectedExistingIndices.length === 0 && selectedNewIndices.length === 0 && checkedRemovalPseudos.length === 0) {
            showToast('No players selected.', 'error');
            return;
        }

        var selectedExisting = selectedExistingIndices.map(function (idx) { return ocrExtractedPlayers[idx]; }).filter(Boolean);
        var selectedNew = selectedNewIndices.map(function (idx) { return ocrExtractedPlayers[idx]; }).filter(Boolean);

        // Pre-flight 1: Validate UIDs and check duplicates within new members batch
        var invalidUidPseudos = [];
        var newUidSeen = new Set();
        var duplicateNewUids = [];

        for (var n = 0; n < selectedNew.length; n++) {
            var np = selectedNew[n];
            var uidVal = (np.uid || '').trim();
            if (uidVal) {
                var uidErr = (window.GM && window.GM.validateUid) ? window.GM.validateUid(uidVal) : null;
                if (uidErr) {
                    invalidUidPseudos.push(np.pseudo + ' (' + uidVal + ')');
                } else if (newUidSeen.has(uidVal)) {
                    duplicateNewUids.push(uidVal);
                } else {
                    newUidSeen.add(uidVal);
                }
            }
        }

        if (invalidUidPseudos.length > 0) {
            showToast('Invalid UID for: ' + invalidUidPseudos.join(', '), 'error');
            return;
        }

        if (duplicateNewUids.length > 0) {
            showToast('Duplicate UID in batch: ' + duplicateNewUids.join(', '), 'error');
            return;
        }

        // Pre-flight 2: global UID collision + ban check (check_uid_exists_globally /
        // gm_find_player_by_uid / banned_players — same RPCs the manual Add Member
        // dialog uses). Resolved per-row rather than blocking the whole batch: OCR
        // is a bulk operation, so one flagged player shouldn't hold back clean
        // updates, adds, and removals. Flagged rows are dropped from this commit;
        // the admin resolves them afterward via the single Add Member flow, which
        // already has the full rename/transfer-request dialog for this exact case.
        if (newUidSeen.size > 0) {
            btnCommit.disabled = true;
            var preSpan = btnCommit.querySelector('span');
            if (preSpan) preSpan.textContent = 'Checking UIDs...';

            var dbClient = (window.GM && window.GM.db) ? window.GM.db : supabase;
            var uidArray = Array.from(newUidSeen);
            var collidingUidInfo = {};
            var bannedUidSet = new Set();

            for (var u = 0; u < uidArray.length; u++) {
                var targetUid = uidArray[u];
                try {
                    var chkRes = await dbClient.rpc('check_uid_exists_globally', { p_uid: targetUid });
                    if (chkRes && chkRes.data === true) {
                        try {
                            var lookupRes = await dbClient.rpc('gm_find_player_by_uid', { p_uid: targetUid });
                            collidingUidInfo[targetUid] = (lookupRes && lookupRes.data && lookupRes.data.ok) ? lookupRes.data : null;
                        } catch (lookupErr) {
                            console.warn('gm_find_player_by_uid failed for ' + targetUid + ':', lookupErr);
                            collidingUidInfo[targetUid] = null;
                        }
                    }
                } catch (rpcErr) {
                    console.warn('Global UID check warning for ' + targetUid + ':', rpcErr);
                }

                try {
                    var banRes = await dbClient.from('banned_players').select('uid').eq('uid', targetUid);
                    if (banRes.data && banRes.data.length > 0) {
                        bannedUidSet.add(targetUid);
                    }
                } catch (banErr) {
                    console.warn('Ban check warning for ' + targetUid + ':', banErr);
                }
            }

            var collidingLabels = [];
            var bannedLabels = [];
            if (Object.keys(collidingUidInfo).length > 0 || bannedUidSet.size > 0) {
                selectedNew = selectedNew.filter(function (np) {
                    var uidVal = (np.uid || '').trim();
                    if (!uidVal) return true;
                    if (bannedUidSet.has(uidVal)) {
                        bannedLabels.push(np.pseudo + ' (' + uidVal + ')');
                        return false;
                    }
                    if (Object.prototype.hasOwnProperty.call(collidingUidInfo, uidVal)) {
                        var info = collidingUidInfo[uidVal];
                        var ownerGuild = info && info.player && info.player.guild ? info.player.guild : '?';
                        collidingLabels.push(np.pseudo + ' (already in ' + ownerGuild + ')');
                        return false;
                    }
                    return true;
                });
            }

            if (collidingLabels.length > 0 || bannedLabels.length > 0) {
                var skipParts = [];
                if (collidingLabels.length > 0) skipParts.push('UID already registered — ' + collidingLabels.join(', ') + '. Resolve via Add Member.');
                if (bannedLabels.length > 0) skipParts.push('Banned — ' + bannedLabels.join(', ') + '.');
                showToast('Skipped: ' + skipParts.join(' '), 'error');

                if (selectedExisting.length === 0 && selectedNew.length === 0 && checkedRemovalPseudos.length === 0) {
                    btnCommit.disabled = false;
                    if (preSpan) preSpan.textContent = 'Validate & Apply Updates';
                    return;
                }
            }
        }

        async function executeRosterCommit() {
            btnCommit.disabled = true;
            var span = btnCommit.querySelector('span');
            if (span) span.textContent = 'Validating & Saving...';

            var updatedCount = 0;
            var addedCount = 0;
            var removedCount = 0;
            var failedCount = 0;
            var rankAssignedCount = 0;

            try {
                var db = (window.GM && window.GM.db) ? window.GM.db : supabase;
                var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';

                // 1. Apply existing member updates
                await window.GM.runInChunks(selectedExisting, 10, async function (sp) {
                    var scoreVal = sp.score != null ? sp.score : (sp.overall_power || 0);
                    var existing = guildMembers.find(function (m) { return m.pseudo.toLowerCase() === sp.pseudo.toLowerCase(); });

                    if (existing) {
                        if (targetField === 'glory_score') {
                            // Glory is a WEEKLY score: route through gm_upsert_player_glory so the
                            // event_participants row (the Glory tab's data source, filtered by week_start)
                            // is written for the current ISO week AND guild_members.glory_score stays in
                            // sync. The plain guild_members update never populated the weekly view.
                            var gloryWeek = (window.GM && window.GM.getWeekStart) ? window.GM.getWeekStart() : new Date().toISOString().slice(0, 10);
                            var glRes = await db.rpc('gm_upsert_player_glory', {
                                p_guild: currentG,
                                p_pseudo: existing.pseudo,
                                p_week_start: gloryWeek,
                                p_glory: scoreVal
                            });
                            var glRow = glRes.error ? null : (Array.isArray(glRes.data) ? glRes.data[0] : glRes.data);
                            if (glRes.error || !glRow || !glRow.ok) {
                                failedCount++;
                                console.error('Failed to update glory for ' + existing.pseudo + ':', glRes.error || (glRow && glRow.error));
                                return;
                            }
                            existing.glory_score = scoreVal;
                            existing.metrics_updated_at = new Date().toISOString();
                            updatedCount++;
                        } else {
                            var updatePayload = {};
                            updatePayload[targetField] = scoreVal;
                            updatePayload.metrics_updated_at = new Date().toISOString();
                            if (targetField === 'overall_power') {
                                updatePayload.power_updated_at = new Date().toISOString();
                            }

                            // Members OCR can also carry a rank detected from the
                            // roster's section headers (Executive Manager / Rank 3 /
                            // Rank 2 / Rank 1 Members) — apply it via the same
                            // bulk-assignment eligibility check the manual R1-R4
                            // buttons already enforce, so R5 stays protected and
                            // only ever-valid targets get through.
                            var rankChanged = false;
                            if (currentOcrMetric === 'members' && sp.rank && window.GM && window.GM.isRoleAllowedForBulk && window.GM.isRoleAllowedForBulk(sp.rank) && existing.role !== 'R5') {
                                updatePayload.role = sp.rank;
                                rankChanged = sp.rank !== existing.role;
                            }

                            var upRes = await db.from('guild_members')
                                .update(updatePayload)
                                .eq('guild', currentG)
                                .eq('pseudo', existing.pseudo);

                            if (upRes.error) {
                                failedCount++;
                                console.error('Failed to update member ' + existing.pseudo + ':', upRes.error);
                                return;
                            }

                            existing[targetField] = scoreVal;
                            existing.metrics_updated_at = updatePayload.metrics_updated_at;
                            if (updatePayload.role) existing.role = updatePayload.role;
                            if (rankChanged) rankAssignedCount++;
                            updatedCount++;
                        }

                        // Snapshot to player_metrics_history
                        if (window.GM && window.GM.upsertPlayerMetrics) {
                            try {
                                await window.GM.upsertPlayerMetrics(currentG, existing.pseudo, existing.uid, {
                                    overall_power: existing.overall_power || 0,
                                    fleet_rating: existing.fleet_rating || 0,
                                    tech_power: existing.tech_power || 0,
                                    flagship_power: existing.flagship_power || 0,
                                    champion_power: existing.champion_power || 0,
                                    crew_power: existing.crew_power || 0,
                                    glory_score: existing.glory_score || 0
                                });
                            } catch (histErr) {
                                console.warn('Failed to snapshot player metrics history:', histErr);
                            }
                        }
                    }
                });

                // 2. Apply new member inserts
                await window.GM.runInChunks(selectedNew, 10, async function (np) {
                    var nScore = np.score != null ? np.score : (np.overall_power || 0);
                    var assignedUid = (np.uid && String(np.uid).trim()) ? String(np.uid).trim() : ('TEMP-' + Math.random().toString(36).substring(2, 10));

                    var newMember = {
                        pseudo: np.pseudo,
                        uid: assignedUid,
                        overall_power: targetField === 'overall_power' ? nScore : 0,
                        fleet_rating: targetField === 'fleet_rating' ? nScore : 0,
                        tech_power: targetField === 'tech_power' ? nScore : 0,
                        flagship_power: targetField === 'flagship_power' ? nScore : 0,
                        champion_power: targetField === 'champion_power' ? nScore : 0,
                        crew_power: targetField === 'crew_power' ? nScore : 0,
                        glory_score: targetField === 'glory_score' ? nScore : 0,
                        guild: currentG,
                        // Use the rank detected from (or corrected on) the roster's
                        // section headers when it's a valid assignable target;
                        // otherwise keep the long-standing R1 default for a
                        // brand-new member.
                        role: (window.GM && window.GM.isRoleAllowedForBulk && window.GM.isRoleAllowedForBulk(np.rank)) ? np.rank : 'R1'
                    };
                    if (newMember.role !== 'R1') rankAssignedCount++;

                    var insRes = await db.from('guild_members').insert([newMember]);
                    if (insRes.error) {
                        failedCount++;
                        console.error('Failed to insert member ' + newMember.pseudo + ':', insRes.error);
                        return;
                    }

                    guildMembers.push(newMember);
                    addedCount++;

                    // Glory OCR on a new member: also record the weekly event_participants
                    // row so the Glory tab shows the score for the current week.
                    if (targetField === 'glory_score' && nScore > 0) {
                        try {
                            var gloryWeekNew = (window.GM && window.GM.getWeekStart) ? window.GM.getWeekStart() : new Date().toISOString().slice(0, 10);
                            var glNewRes = await db.rpc('gm_upsert_player_glory', {
                                p_guild: currentG,
                                p_pseudo: newMember.pseudo,
                                p_week_start: gloryWeekNew,
                                p_glory: nScore
                            });
                            var glNewRow = glNewRes.error ? null : (Array.isArray(glNewRes.data) ? glNewRes.data[0] : glNewRes.data);
                            if (glNewRes.error || !glNewRow || !glNewRow.ok) {
                                console.warn('Inserted member ' + newMember.pseudo + ' but weekly glory row failed:', glNewRes.error || (glNewRow && glNewRow.error));
                            }
                        } catch (glNewErr) {
                            console.warn('Failed to record weekly glory for new member ' + newMember.pseudo + ':', glNewErr);
                        }
                    }

                    // Snapshot to player_metrics_history
                    if (window.GM && window.GM.upsertPlayerMetrics) {
                        try {
                            await window.GM.upsertPlayerMetrics(currentG, newMember.pseudo, newMember.uid, {
                                overall_power: newMember.overall_power,
                                fleet_rating: newMember.fleet_rating,
                                tech_power: newMember.tech_power,
                                flagship_power: newMember.flagship_power,
                                champion_power: newMember.champion_power,
                                crew_power: newMember.crew_power,
                                glory_score: newMember.glory_score
                            });
                        } catch (histErr) {
                            console.warn('Failed to snapshot new member metrics history:', histErr);
                        }
                    }
                });

                // 3. Apply removals (hard delete with cascade)
                if (checkedRemovalPseudos.length > 0) {
                    var delRes = await db.from('guild_members')
                        .delete()
                        .eq('guild', currentG)
                        .in('pseudo', checkedRemovalPseudos);

                    if (delRes.error) {
                        console.error('Failed to remove members:', delRes.error);
                        showToast('Error removing members: ' + delRes.error.message, 'error');
                    } else {
                        removedCount = checkedRemovalPseudos.length;
                    }
                }

                // 4. Refresh full roster in memory & re-render view
                if (typeof fetchGuildMembers === 'function') {
                    await fetchGuildMembers();
                }
                renderGuildMembers();

                // 5. Close modal
                var modal = document.getElementById('ocr-modal-overlay');
                if (modal) {
                    modal.classList.remove('visible');
                    modal.style.display = 'none';
                }

                // 6. Output aggregate toast summary
                var summaryMsg = '';
                if (currentOcrMetric === 'members') {
                    summaryMsg = 'Updated ' + updatedCount + ' · Added ' + addedCount + ' · Removed ' + removedCount;
                    if (rankAssignedCount > 0) summaryMsg += ' · Ranks assigned ' + rankAssignedCount;
                } else {
                    var activeTag = (document.getElementById('ocr-guild-tag-input') && document.getElementById('ocr-guild-tag-input').value.trim()) ? document.getElementById('ocr-guild-tag-input').value.trim() : '';
                    var curDiff = categorizeOcrDiff(ocrExtractedPlayers, guildMembers, activeTag, targetField, meta.isMultiGuild, 'metric');
                    var skippedCount = (curDiff.unknown && curDiff.unknown.length) ? curDiff.unknown.length : 0;
                    summaryMsg = 'Updated ' + updatedCount + (skippedCount > 0 ? ' · Skipped ' + skippedCount + ' not in roster (use Members OCR)' : '');
                }
                if (failedCount > 0) summaryMsg += ' · Failed ' + failedCount;
                showToast(summaryMsg, failedCount > 0 ? 'warning' : 'success');
                if (window.GM && window.GM.cache) window.GM.cache.invalidate();
            } catch (err) {
                console.error('Commit OCR error:', err);
                showToast('Failed to save OCR updates: ' + (err.message || err), 'error');
            } finally {
                btnCommit.disabled = false;
                var finalSpan = btnCommit.querySelector('span');
                if (finalSpan) finalSpan.textContent = 'Validate & Apply Updates';
            }
        }

        // Check if removal confirmation dialog is required
        if (checkedRemovalPseudos.length > 0) {
            var listPreview = checkedRemovalPseudos.slice(0, 8).map(function (p) { return esc(p); }).join(', ') + (checkedRemovalPseudos.length > 8 ? ' and ' + (checkedRemovalPseudos.length - 8) + ' more' : '');
            var confirmMsg = 'Are you sure you want to permanently remove <strong>' + checkedRemovalPseudos.length + ' member(s)</strong> (' + listPreview + ')?<br><br><span style="color:#f87171; font-size:0.85rem;">This permanently deletes the member and their event participations, shadowfront squads, weekly scores and sanctions.</span>';

            if (typeof showConfirm === 'function') {
                showConfirm('Confirm Roster Removals', confirmMsg, function () {
                    executeRosterCommit();
                });
            } else {
                executeRosterCommit();
            }
        } else {
            await executeRosterCommit();
        }
    }

    // ─── Guild Members & Transfers ──────────────────────────────────────────
    var pendingTransfers = [];

    async function fetchGuildMembers() {
        if (!supabase) return;
        initOcrGeminiModule();
        var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        try {
            var [res, transfersRes, absencesRes, gloryRes] = await Promise.all([
                supabase.from('guild_members').select('*').eq('guild', currentG).order('pseudo', { ascending: true }),
                supabase.from('guild_transfers').select('id, uid, pseudo, source_guild, target_guild').eq('status', 'pending').order('created_at', { ascending: true }),
                supabase.from('player_absences').select('*').eq('guild', currentG),
                supabase.from('event_participants').select('pseudo, score, week_start').eq('guild', currentG).eq('event_name', 'Glory').not('score', 'is', null).order('week_start', { ascending: false })
            ]);
            
            if (res.error) throw res.error;

            var latestGloryMap = {};
            if (gloryRes && !gloryRes.error && Array.isArray(gloryRes.data)) {
                gloryRes.data.forEach(function (r) {
                    if (r && r.pseudo && r.score != null) {
                        var pKey = r.pseudo.trim().toLowerCase();
                        if (latestGloryMap[pKey] === undefined) {
                            latestGloryMap[pKey] = parseInt(r.score, 10) || 0;
                        }
                    }
                });
            }

            guildMembers = (res.data || []).map(function (m) {
                var pKey = (m.pseudo || '').trim().toLowerCase();
                var lastGlory = latestGloryMap[pKey];
                if (lastGlory !== undefined && lastGlory > 0) {
                    if (!m.glory_score || parseInt(m.glory_score) === 0 || parseInt(m.glory_score) !== lastGlory) {
                        m.glory_score = lastGlory;
                    }
                }
                return m;
            });
            
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
                    '<button type="button" class="gm-btn gm-btn-sm gm-btn-success" data-transfer-action="approve" data-transfer-id="' + esc(t.id) + '" style="margin-right: 0.25rem;" title="Approve Transfer"><i class="ph ph-check"></i></button>' +
                    '<button type="button" class="gm-btn gm-btn-sm gm-btn-danger" data-transfer-action="reject" data-transfer-id="' + esc(t.id) + '" title="Reject Transfer"><i class="ph ph-x"></i></button>';
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
        list.querySelectorAll('[data-transfer-action]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                window.GM.resolveTransfer(btn.getAttribute('data-transfer-id'), btn.getAttribute('data-transfer-action'));
            });
        });
    }

    var TRANSFER_ERROR_MESSAGES = {
        permission_denied: 'You do not have permission to resolve this transfer.',
        transfer_not_found_or_resolved: 'This transfer was already resolved or no longer exists.',
        subscription_expired: 'Your guild\'s subscription is not active.',
        member_no_longer_in_source: 'This player has already left their original guild — the transfer is no longer valid.',
        uid_already_in_target: 'A member with this UID already exists in your guild.',
        duplicate_pseudo_in_target: 'A member with this name already exists in your guild.',
        invalid_action: 'Unrecognized action.'
    };

    window.GM = window.GM || {};
    window.GM.resolveTransfer = async function(transferId, action) {
        if (!supabase) return;
        var title = action === 'approve' ? 'Approve Transfer' : 'Reject Transfer';
        var message = action === 'approve' ? 'Approve this transfer and add the player to your guild?' : 'Reject this transfer request?';

        window.showConfirm(title, message, async function () {
            try {
                var { data, error } = await supabase.rpc('resolve_guild_transfer', {
                    p_transfer_id: transferId,
                    p_action: action
                });

                if (error || !data || !data.ok) {
                    var errCode = (data && data.error) ? data.error : null;
                    var errStr = (errCode && TRANSFER_ERROR_MESSAGES[errCode]) || (error ? error.message : 'Unknown error.');
                    showToast('Failed to ' + action + ' transfer: ' + errStr, 'error');
                    fetchGuildMembers();
                } else {
                    showToast('Transfer ' + action + 'd successfully.', 'success');
                    fetchGuildMembers();
                    if (window.GM && window.GM.cache) window.GM.cache.invalidate();
                }
            } catch (err) {
                console.error(err);
                showToast('Error processing transfer.', 'error');
            }
        });
    };

    // ── UID already taken: show where the player lives + transfer request OR update same-guild player ──
    // info comes from gm_find_player_by_uid: { player, name_history }
    async function showUidTakenDialog(typedPseudo, uid, info, extraData) {
        var existing = document.getElementById('uid-taken-overlay');
        if (existing) existing.remove();

        var p = info.player || {};
        var server = p.server_number ? 'Server #' + p.server_number : 'Server unknown';
        var currentG = window.GM ? window.GM.getActiveGuild() : (window.currentGuildRestriction || window.currentGuild || localStorage.getItem('gm_current_guild') || 'ALPHA');

        var isSameGuild = Boolean(
            (p.guild && currentG && p.guild.trim().toUpperCase() === currentG.trim().toUpperCase()) ||
            guildMembers.some(function (m) { return m.uid && String(m.uid).trim() === String(uid).trim(); })
        );

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
        overlay.className = 'gm-modal-overlay';

        var titleHtml = '';
        var bodyHtml = '';
        var noticeHtml = '';
        var footerHtml = '';

        if (isSameGuild) {
            var localExisting = guildMembers.find(function (m) { return m.uid && String(m.uid).trim() === String(uid).trim(); });
            var existingPseudo = p.pseudo || (localExisting ? localExisting.pseudo : 'Existing Player');
            var displayPower = extraData && !isNaN(extraData.power) ? extraData.power : (p.overall_power || (localExisting ? localExisting.overall_power : 0));
            var displayRole = (extraData && extraData.role) || p.role || (localExisting ? localExisting.role : 'R1');

            titleHtml =
                '<div style="display:flex; align-items:center; gap:0.5rem;">' +
                    '<i class="ph ph-user-switch" style="font-size:1.5rem; color:var(--accent);"></i>' +
                    '<h3 style="margin:0; font-size:1.2rem;">Player Already in Guild</h3>' +
                '</div>';

            bodyHtml =
                '<div style="background: rgba(255,255,255,0.03); border:1px solid var(--border-soft); border-radius:8px; padding:0.9rem; display:flex; flex-direction:column; gap:0.4rem;">' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Current Name</span><strong style="color:var(--fg);">' + esc(existingPseudo) + '</strong></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">New Name</span><strong style="color:var(--accent);">' + esc(typedPseudo) + '</strong></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Player ID</span><span class="gm-uid-badge">' + esc(uid) + '</span></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Guild</span><strong style="color:var(--accent);">' + esc(p.guild || currentG) + '</strong></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Server</span><span>' + esc(server) + '</span></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Rank</span><span>' + esc(displayRole) + '</span></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Power</span><span>' + esc(window.GM ? window.GM.formatPower(displayPower) : String(displayPower)) + '</span></div>' +
                    historyHtml +
                '</div>';

            noticeHtml =
                '<div style="background: var(--info-soft); color: var(--info); padding:0.75rem; border-radius:6px; border:1px solid var(--info-soft); font-size:0.8rem; line-height:1.45; margin-top:0.85rem;">' +
                    '<i class="ph ph-info" style="margin-right:4px;"></i>' +
                    'This player (<strong>' + esc(existingPseudo) + '</strong>) already belongs to <strong>' + esc(p.guild || currentG) + '</strong>. Would you like to update their name to <strong>' + esc(typedPseudo) + '</strong>?' +
                '</div>';

            footerHtml =
                '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:1.4rem;">' +
                    '<button type="button" class="gm-btn gm-btn-ghost gm-close-uid">Cancel</button>' +
                    '<button type="button" id="uid-rename-btn" class="gm-btn gm-btn-primary">' +
                        '<i class="ph ph-pencil-simple"></i> <span>Update Player Name</span>' +
                    '</button>' +
                '</div>';
        } else {
            titleHtml =
                '<div style="display:flex; align-items:center; gap:0.5rem;">' +
                    '<i class="ph ph-user-circle-gear" style="font-size:1.5rem; color:var(--accent);"></i>' +
                    '<h3 style="margin:0; font-size:1.2rem;">Player ID already exists</h3>' +
                '</div>';

            bodyHtml =
                '<div style="background: rgba(255,255,255,0.03); border:1px solid var(--border-soft); border-radius:8px; padding:0.9rem; display:flex; flex-direction:column; gap:0.4rem;">' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Player</span><strong style="color:var(--fg);">' + esc(p.pseudo || typedPseudo) + '</strong></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Player ID</span><span class="gm-uid-badge">' + esc(uid) + '</span></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Current Guild</span><strong style="color:var(--accent);">' + esc(p.guild || '?') + '</strong></div>' +
                    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Server</span><span>' + esc(server) + '</span></div>' +
                    (p.role ? '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">Rank</span><span>' + esc(p.role) + '</span></div>' : '') +
                    historyHtml +
                '</div>';

            noticeHtml =
                '<div style="background: var(--info-soft); color: var(--info); padding:0.75rem; border-radius:6px; border:1px solid var(--info-soft); font-size:0.8rem; line-height:1.45; margin-top:0.85rem;">' +
                    '<i class="ph ph-info" style="margin-right:4px;"></i>' +
                    'This player already belongs to <strong>' + esc(p.guild || 'another guild') + '</strong>. You cannot add them directly here. You can send a transfer request so an admin approves moving them to <strong>' + esc(currentG) + '</strong>.' +
                '</div>' +
                '<label style="display:flex; align-items:flex-start; gap:0.5rem; margin-top:0.85rem; cursor:pointer; font-size:0.82rem; color:var(--text-muted);">' +
                    '<input type="checkbox" id="uid-taken-confirm" style="margin-top:2px; accent-color: var(--accent);">' +
                    '<span>I understand this process cannot be undone without reporting an issue or bug, and that the transfer must be approved by an admin.</span>' +
                '</label>';

            footerHtml =
                '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:1.4rem;">' +
                    '<button type="button" class="gm-btn gm-btn-ghost gm-close-uid">Cancel</button>' +
                    '<button type="button" id="uid-taken-request-btn" class="gm-btn gm-btn-primary" disabled>' +
                        '<i class="ph ph-arrows-left-right"></i> <span>Request Transfer</span>' +
                    '</button>' +
                '</div>';
        }

        overlay.innerHTML =
            '<div class="gm-modal-card" style="max-width: 520px; width: 92%; position: relative; text-align:left;">' +
                '<div class="gm-modal-header" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:1rem;">' +
                    titleHtml +
                    '<button type="button" class="gm-mini-btn gm-close-uid" style="cursor:pointer;"><i class="ph ph-x"></i></button>' +
                '</div>' +
                bodyHtml +
                noticeHtml +
                footerHtml +
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

        if (isSameGuild) {
            var renameBtn = document.getElementById('uid-rename-btn');
            if (renameBtn) {
                renameBtn.addEventListener('click', async function () {
                    renameBtn.disabled = true;
                    var span = renameBtn.querySelector('span');
                    if (span) span.textContent = 'Updating...';

                    var localExisting = guildMembers.find(function (m) { return m.uid && String(m.uid).trim() === String(uid).trim(); });
                    var existingPseudo = p.pseudo || (localExisting ? localExisting.pseudo : typedPseudo);
                    var newPower = extraData && !isNaN(extraData.power) ? extraData.power : (p.overall_power || (localExisting ? localExisting.overall_power : 0));
                    var newRole = (extraData && extraData.role) || p.role || (localExisting ? localExisting.role : 'R1');
                    var extraMetrics = extraData ? {
                        fleet_rating: extraData.fleet_rating,
                        tech_power: extraData.tech_power,
                        flagship_power: extraData.flagship_power,
                        champion_power: extraData.champion_power,
                        crew_power: extraData.crew_power,
                        glory_score: extraData.glory_score
                    } : {};

                    try {
                        var ok = await renameGuildMember(existingPseudo, typedPseudo, uid, newPower, newRole, extraMetrics);
                        if (ok) {
                            if (extraData && extraData.inputs) {
                                if (extraData.inputs.input) extraData.inputs.input.value = '';
                                if (extraData.inputs.uidInput) extraData.inputs.uidInput.value = '';
                                if (extraData.inputs.powerInput) extraData.inputs.powerInput.value = '';
                                if (extraData.inputs.roleInput) extraData.inputs.roleInput.value = 'R1';
                                if (extraData.inputs.fleetInput) extraData.inputs.fleetInput.value = '';
                                if (extraData.inputs.techInput) extraData.inputs.techInput.value = '';
                                if (extraData.inputs.flagshipInput) extraData.inputs.flagshipInput.value = '';
                                if (extraData.inputs.champInput) extraData.inputs.champInput.value = '';
                                if (extraData.inputs.crewInput) extraData.inputs.crewInput.value = '';
                                if (extraData.inputs.gloryInput) extraData.inputs.gloryInput.value = '';
                            }
                            closeDialog();
                        } else {
                            renameBtn.disabled = false;
                            if (span) span.textContent = 'Update Player Name';
                        }
                    } catch (err) {
                        console.error('Rename failed', err);
                        showToast('Failed to update player name: ' + err.message, 'error');
                        renameBtn.disabled = false;
                        if (span) span.textContent = 'Update Player Name';
                    }
                });
            }
        } else {
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

        var fleetInput    = document.getElementById('member-fleet');
        var techInput     = document.getElementById('member-tech');
        var flagshipInput = document.getElementById('member-flagship');
        var champInput    = document.getElementById('member-champ');
        var crewInput     = document.getElementById('member-crew');
        var gloryInput    = document.getElementById('member-glory');

        var fleetVal    = fleetInput    ? (parseInt(fleetInput.value) || 0) : 0;
        var techVal     = techInput     ? (parseInt(techInput.value) || 0) : 0;
        var flagshipVal = flagshipInput ? (parseInt(flagshipInput.value) || 0) : 0;
        var champVal    = champInput    ? (parseInt(champInput.value) || 0) : 0;
        var crewVal     = crewInput     ? (parseInt(crewInput.value) || 0) : 0;
        var gloryVal    = gloryInput    ? (parseInt(gloryInput.value) || 0) : 0;

        var extraData = {
            power: powerVal,
            role: roleVal,
            fleet_rating: fleetVal,
            tech_power: techVal,
            flagship_power: flagshipVal,
            champion_power: champVal,
            crew_power: crewVal,
            glory_score: gloryVal,
            inputs: {
                input: input,
                uidInput: uidInput,
                powerInput: powerInput,
                roleInput: roleInput,
                fleetInput: fleetInput,
                techInput: techInput,
                flagshipInput: flagshipInput,
                champInput: champInput,
                crewInput: crewInput,
                gloryInput: gloryInput
            }
        };

        try {
            var uidCheck = await supabase.rpc('check_uid_exists_globally', { p_uid: String(uidVal).trim() });
            if (uidCheck.error) throw uidCheck.error;
            if (uidCheck.data) {
                // The UID exists somewhere: show where the player currently
                // lives and offer a transfer request or rename prompt if same guild.
                var lookup = await supabase.rpc('gm_find_player_by_uid', { p_uid: String(uidVal).trim() });
                if (lookup.error) throw lookup.error;
                var info = lookup.data || {};
                if (!info.ok) throw new Error(info.error || 'lookup_failed');
                if (info.found || info.player) {
                    showUidTakenDialog(pseudo, uidVal, info, extraData);
                    return;
                }
                // Fallback: global check says it exists but lookup found nothing.
                showToast('Player ID is already in use. Use Transfer instead.', 'error');
                return;
            }
        } catch (err) {
            console.error('Global UID check failed', err);
            // Fallback to local check if RPC fails
            var localExisting = guildMembers.find(function (m) { return m.uid && String(m.uid).trim() === String(uidVal).trim(); });
            if (localExisting) {
                showUidTakenDialog(pseudo, uidVal, {
                    ok: true,
                    found: true,
                    player: {
                        pseudo: localExisting.pseudo,
                        uid: localExisting.uid,
                        guild: window.GM ? window.GM.getActiveGuild() : 'ALPHA',
                        role: localExisting.role,
                        overall_power: localExisting.overall_power
                    },
                    name_history: []
                }, extraData);
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
            var fleetInput    = document.getElementById('member-fleet');
            var techInput     = document.getElementById('member-tech');
            var flagshipInput = document.getElementById('member-flagship');
            var champInput    = document.getElementById('member-champ');
            var crewInput     = document.getElementById('member-crew');
            var gloryInput    = document.getElementById('member-glory');

            var fleetVal    = fleetInput    ? (parseInt(fleetInput.value) || 0) : 0;
            var techVal     = techInput     ? (parseInt(techInput.value) || 0) : 0;
            var flagshipVal = flagshipInput ? (parseInt(flagshipInput.value) || 0) : 0;
            var champVal    = champInput    ? (parseInt(champInput.value) || 0) : 0;
            var crewVal     = crewInput     ? (parseInt(crewInput.value) || 0) : 0;
            var gloryVal    = gloryInput    ? (parseInt(gloryInput.value) || 0) : 0;

            var newMemberRow = {
                pseudo: pseudo,
                uid: uidVal,
                overall_power: powerVal,
                role: roleVal,
                guild: currentG,
                fleet_rating: fleetVal,
                tech_power: techVal,
                flagship_power: flagshipVal,
                champion_power: champVal,
                crew_power: crewVal,
                glory_score: gloryVal
            };

            var res = await supabase.from('guild_members').insert([newMemberRow]);
            if (res.error) throw res.error;
            newMemberRow.created_at = new Date().toISOString();
            guildMembers.push(newMemberRow);

            if (input) input.value = '';
            if (uidInput) uidInput.value = '';
            if (powerInput) powerInput.value = '';
            if (roleInput) roleInput.value = 'R1';
            if (fleetInput) fleetInput.value = '';
            if (techInput) techInput.value = '';
            if (flagshipInput) flagshipInput.value = '';
            if (champInput) champInput.value = '';
            if (crewInput) crewInput.value = '';
            if (gloryInput) gloryInput.value = '';

            // Also snapshot metrics history if any values provided
            if (fleetVal || techVal || flagshipVal || champVal || crewVal || gloryVal || powerVal) {
                try {
                    await supabase.rpc('gm_upsert_player_metrics', {
                        p_guild: currentG,
                        p_pseudo: pseudo,
                        p_total_power: powerVal,
                        p_tech_power: techVal,
                        p_champion_power: champVal,
                        p_crew_power: crewVal,
                        p_flagship_power: flagshipVal,
                        p_fleet_rating: fleetVal,
                        p_glory_score: gloryVal
                    });
                } catch (e) {
                    console.error('Initial player metrics snapshot error:', e);
                }
            }

            renderGuildMembers();
            showToast(pseudo + ' ' + t('toast_member_added'), 'success');
            if (window.GM && window.GM.cache) window.GM.cache.invalidate();

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

    var toggleMilitaryBtn = document.getElementById('toggle-add-member-military');
    var militaryFields = document.getElementById('add-member-military-fields');
    if (toggleMilitaryBtn && militaryFields) {
        toggleMilitaryBtn.addEventListener('click', function () {
            var isHidden = militaryFields.style.display === 'none';
            militaryFields.style.display = isHidden ? 'grid' : 'none';
            var span = toggleMilitaryBtn.querySelector('span');
            if (span) {
                span.textContent = isHidden ? '- Hide Optional Military Scores' : '+ Optional Military Scores (Fleet, Tech, Flagship, Champions, Crew, Glory)';
            }
        });
    }

    if (addMemberForm)  addMemberForm.addEventListener('submit', function (e)  { e.preventDefault(); handleAddMember('member-pseudo', 'member-uid', 'member-power', 'member-role'); });
    if (addBannedForm) {
        addBannedForm.addEventListener('submit', function (e) { e.preventDefault(); handleAddBannedPlayer(); });
    }

    // Search boxes re-render the whole roster on every keystroke; debounce so
    // a burst of typing collapses into a single render instead of one per
    // character. Filter/sort renders skip the unrelated absence/timezone
    // subpanels (renderGuildMembers(true)) since neither depends on them.
    var gmDebounce = (window.GM && window.GM.debounce) ? window.GM.debounce : function (fn) { return fn; };
    var debouncedMemberSearch = gmDebounce(function () { renderGuildMembers(true); }, 200);
    var handleRosterFilterChange = function () { renderGuildMembers(true); };

    var searchAdmin = document.getElementById('member-search-admin');
    if (searchAdmin) searchAdmin.addEventListener('input', debouncedMemberSearch);
    var tierAdminSelect = document.getElementById('member-tier-filter-admin');
    if (tierAdminSelect) tierAdminSelect.addEventListener('change', handleRosterFilterChange);
    var sortAdminSelect = document.getElementById('member-sort-admin');
    if (sortAdminSelect) sortAdminSelect.addEventListener('change', handleRosterFilterChange);
    if (bannedSearch) {
        bannedSearch.addEventListener('input', gmDebounce(renderBannedPlayers, 200));
    }

    async function deleteGuildMember(pseudo) {
        try {
            // ON DELETE CASCADE fait le ménage côté DB sur :
            //   event_participants, shadowfront_squads, weekly_scores, sanctions
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            var res = await supabase.from('guild_members').delete().eq('pseudo', pseudo).eq('guild', currentG);
            if (res.error) throw res.error;
            guildMembers = guildMembers.filter(function (m) { return m.pseudo !== pseudo; });
            renderGuildMembers();
            showToast(t('toast_member_removed'), 'success');
            if (window.GM && window.GM.cache) window.GM.cache.invalidate();

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

    async function renameGuildMember(oldPseudo, newPseudo, newUid, newPower, newRole, extraMetrics) {
        newPseudo = (newPseudo || '').trim();
        newUid    = (newUid || '').trim();
        var powerVal = parseInt(newPower) || 0;
        var roleVal = newRole || 'R1';
        extraMetrics = extraMetrics || {};

        var pseudoErr = window.GM.validatePseudo(newPseudo);
        if (pseudoErr) { showToast(t(pseudoErr), 'error'); return false; }
        var uidErr = window.GM.validateUid(newUid);
        if (uidErr) { showToast(t(uidErr), 'error'); return false; }

        var member = guildMembers.find(function (m) {
            return (m.pseudo && m.pseudo.toLowerCase() === oldPseudo.toLowerCase()) ||
                   (m.uid && newUid && String(m.uid).trim() === String(newUid).trim());
        });
        var oldPower = member ? parseInt(member.overall_power) || 0 : 0;
        var oldRole = member ? member.role || 'R1' : 'R1';

        var pseudoChanged = newPseudo.toLowerCase() !== oldPseudo.toLowerCase();
        var uidChanged    = member && (member.uid || '') !== newUid;
        var powerChanged  = oldPower !== powerVal;
        var roleChanged   = oldRole !== roleVal;
        var metricsChanged = extraMetrics.tech_power !== undefined || extraMetrics.champion_power !== undefined ||
                             extraMetrics.crew_power !== undefined || extraMetrics.flagship_power !== undefined ||
                             extraMetrics.fleet_rating !== undefined || extraMetrics.glory_score !== undefined;

        if (!pseudoChanged && !uidChanged && !powerChanged && !roleChanged && !metricsChanged) return true;

        if (pseudoChanged && guildMembers.some(function (m) { return m.pseudo.toLowerCase() === newPseudo.toLowerCase() && (member ? m.pseudo !== member.pseudo : true); })) {
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
            var activeGuild = window.GM ? window.GM.getActiveGuild() : (window.currentGuildRestriction || window.currentGuild || localStorage.getItem('gm_current_guild') || 'ALPHA');
            var targetPseudo = member ? member.pseudo : oldPseudo;

            // Log pseudo change history
            if (pseudoChanged && (newUid || (member && member.uid))) {
                var histIns = await supabase.from('player_name_history').insert({
                    guild: activeGuild,
                    uid: newUid || (member ? member.uid : null),
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
            if (extraMetrics.tech_power !== undefined)     update.tech_power = parseInt(extraMetrics.tech_power) || 0;
            if (extraMetrics.champion_power !== undefined) update.champion_power = parseInt(extraMetrics.champion_power) || 0;
            if (extraMetrics.crew_power !== undefined)     update.crew_power = parseInt(extraMetrics.crew_power) || 0;
            if (extraMetrics.flagship_power !== undefined) update.flagship_power = parseInt(extraMetrics.flagship_power) || 0;
            if (extraMetrics.fleet_rating !== undefined)   update.fleet_rating = parseInt(extraMetrics.fleet_rating) || 0;
            if (extraMetrics.glory_score !== undefined)    update.glory_score = parseInt(extraMetrics.glory_score) || 0;
            update.power_updated_at = new Date().toISOString();
            update.metrics_updated_at = new Date().toISOString();

            var res = await supabase.from('guild_members').update(update).eq('guild', activeGuild).eq('pseudo', targetPseudo);
            if (res.error) throw res.error;

            // Also snapshot into player_metrics_history via RPC if available
            try {
                await supabase.rpc('gm_upsert_player_metrics', {
                    p_guild: window.GM.getActiveGuild(),
                    p_pseudo: newPseudo,
                    p_total_power: powerVal,
                    p_tech_power: update.tech_power !== undefined ? update.tech_power : (member ? member.tech_power : 0),
                    p_champion_power: update.champion_power !== undefined ? update.champion_power : (member ? member.champion_power : 0),
                    p_crew_power: update.crew_power !== undefined ? update.crew_power : (member ? member.crew_power : 0),
                    p_flagship_power: update.flagship_power !== undefined ? update.flagship_power : (member ? member.flagship_power : 0),
                    p_fleet_rating: update.fleet_rating !== undefined ? update.fleet_rating : (member ? member.fleet_rating : 0),
                    p_glory_score: update.glory_score !== undefined ? update.glory_score : (member ? member.glory_score : 0)
                });
            } catch (rpcErr) {
                console.warn('Metrics snapshot RPC fallback', rpcErr);
            }

            await fetchGuildMembers();
            showToast(t('toast_member_updated'), 'success');
            if (window.GM && window.GM.cache) window.GM.cache.invalidate();
            return true;
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
            return false;
        }
    }

    function renderGuildMembers(skipSubpanels) {
        var qAdminInput  = document.getElementById('member-search-admin');
        var qAdmin  = qAdminInput  ? qAdminInput.value.toLowerCase()  : '';

        var tierAdminFilter  = document.getElementById('member-tier-filter-admin');
        var tAdmin  = tierAdminFilter  ? tierAdminFilter.value  : 'ALL';

        var sortAdminSelect  = document.getElementById('member-sort-admin');
        var sortAdmin  = sortAdminSelect  ? sortAdminSelect.value  : 'power_desc';

        // Search/filter/sort re-renders (skipSubpanels=true) don't change
        // absence or timezone data, so there's no need to rebuild those two
        // panels on every keystroke — only data-changing callers do.
        if (!skipSubpanels) {
            renderAbsenceSummary();
            renderTimezoneCoverage();
        }

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
            var matchTier = false;
            if (tAdmin === 'ALL') {
                matchTier = true;
            } else if (tAdmin === 'TEMP_UID') {
                matchTier = window.GM && window.GM.isInvalidOrTempUid ? window.GM.isInvalidOrTempUid(m.uid) : false;
            } else {
                matchTier = (window.GM.getPowerTier(m.overall_power, maxPower) === tAdmin);
            }
            return matchGuild && matchSearch && matchTier;
        });

        function sortMembers(list, sortVal) {
            return list.slice().sort(function (a, b) {
                if (sortVal === 'invalid_uid') {
                    var aInv = (window.GM && window.GM.isInvalidOrTempUid) ? window.GM.isInvalidOrTempUid(a.uid) : false;
                    var bInv = (window.GM && window.GM.isInvalidOrTempUid) ? window.GM.isInvalidOrTempUid(b.uid) : false;
                    if (aInv && !bInv) return -1;
                    if (!aInv && bInv) return 1;
                    var pA = parseInt(a.overall_power) || 0;
                    var pB = parseInt(b.overall_power) || 0;
                    return pB - pA;
                } else if (sortVal === 'pseudo_asc') {
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
                } else if (sortVal === 'fleet_desc') {
                    return (parseInt(b.fleet_rating) || 0) - (parseInt(a.fleet_rating) || 0);
                } else if (sortVal === 'tech_desc') {
                    return (parseInt(b.tech_power) || 0) - (parseInt(a.tech_power) || 0);
                } else if (sortVal === 'flagship_desc') {
                    return (parseInt(b.flagship_power) || 0) - (parseInt(a.flagship_power) || 0);
                } else if (sortVal === 'champ_desc') {
                    return (parseInt(b.champion_power) || 0) - (parseInt(a.champion_power) || 0);
                } else if (sortVal === 'crew_desc') {
                    return (parseInt(b.crew_power) || 0) - (parseInt(a.crew_power) || 0);
                } else if (sortVal === 'glory_desc') {
                    return (parseInt(b.glory_score) || 0) - (parseInt(a.glory_score) || 0);
                } else if (sortVal === 'density_desc' || sortVal === 'rally_desc' || sortVal === 'war_desc') {
                    var rA = window.GM.calculateRallyScore ? window.GM.calculateRallyScore(a) : 0;
                    var rB = window.GM.calculateRallyScore ? window.GM.calculateRallyScore(b) : 0;
                    if (rB !== rA) return rB - rA;
                    var pB = (parseInt(b.overall_power) || 0) - (parseInt(a.overall_power) || 0);
                    if (pB !== 0) return pB;
                    var fB = (parseInt(b.flagship_power) || 0) - (parseInt(a.flagship_power) || 0);
                    if (fB !== 0) return fB;
                    return (parseInt(b.fleet_rating) || 0) - (parseInt(a.fleet_rating) || 0);
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

            var html = '';
            var hasAnyMembers = false;

            roleOrder.forEach(function (role) {
                var membersInRole = grouped[role] || [];
                if (membersInRole.length === 0) return;
                hasAnyMembers = true;

                var isCollapsed = !!window.GM_COLLAPSED_ROLES[role];
                var sorted = sortMembers(membersInRole, sortVal);

                html +=
                    '<div class="gm-role-group' + (isCollapsed ? ' is-collapsed' : '') + '">' +
                        '<div class="gm-role-group-header" data-role="' + role + '">' +
                            '<div class="gm-role-group-title">' +
                                '<i class="ph ph-caret-down gm-role-group-caret"></i>' +
                                '<span class="gm-role-chip">' + role + '</span>' +
                                '<span class="gm-role-group-name">' + esc(roleNames[role] || role) + '</span>' +
                                '<span class="gm-role-group-count">(' + membersInRole.length + ')</span>' +
                            '</div>' +
                        '</div>' +
                        '<div class="gm-role-group-body">' +
                            '<div class="admin-members-grid' + (withActions ? '' : ' gm-member-grid-member') + '">';

                sorted.forEach(function (m, i) {
                    html += memberTileHtml(m, i, withActions, maxPower, portalUids);
                });

                html += '</div></div></div>';
            });

            if (!hasAnyMembers) {
                if (guildMembers.length === 0) {
                    return '<div class="gm-empty gm-empty--coldstart" style="padding:3rem 1rem; text-align:center;">' +
                        '<i class="ph-duotone ph-scan gm-icon" style="font-size:3rem; color:var(--accent); margin-bottom:1rem; display:inline-block;"></i>' +
                        '<div class="gm-empty-title" style="font-size:1.2rem; font-weight:700; margin-bottom:0.5rem;">' + t('empty_members_roster_title') + '</div>' +
                        '<div class="gm-empty-desc" style="color:var(--text-muted); font-size:0.88rem; max-width:460px; margin:0 auto 1.5rem auto; line-height:1.4;">' + t('empty_members_roster_desc') + '</div>' +
                        '<button type="button" class="btn-ocr-trigger gm-btn gm-btn-primary" data-metric="members"><i class="ph ph-scan"></i> ' + t('empty_members_roster_cta') + '</button>' +
                    '</div>';
                }
                return '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
            }
            return html;
        }

        function buildMilitaryMatrixHtml(list, sortVal, withActions, portalUids) {
            sortVal = sortVal || 'rally_desc';
            var sorted = sortMembers(list, sortVal);
            if (sorted.length === 0) {
                if (guildMembers.length === 0) {
                    return '<div class="gm-empty gm-empty--coldstart" style="padding:3rem 1rem; text-align:center;">' +
                        '<i class="ph-duotone ph-scan gm-icon" style="font-size:3rem; color:var(--accent); margin-bottom:1rem; display:inline-block;"></i>' +
                        '<div class="gm-empty-title" style="font-size:1.2rem; font-weight:700; margin-bottom:0.5rem;">' + t('empty_members_roster_title') + '</div>' +
                        '<div class="gm-empty-desc" style="color:var(--text-muted); font-size:0.88rem; max-width:460px; margin:0 auto 1.5rem auto; line-height:1.4;">' + t('empty_members_roster_desc') + '</div>' +
                        '<button type="button" class="btn-ocr-trigger gm-btn gm-btn-primary" data-metric="members"><i class="ph ph-scan"></i> ' + t('empty_members_roster_cta') + '</button>' +
                    '</div>';
                }
                return '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
            }

            // Determine Rally Role assignments based on Absolute Rally Combat Score across the guild roster
            var rallyRankedList = list.slice().sort(function (a, b) {
                var rA = window.GM.calculateRallyScore ? window.GM.calculateRallyScore(a) : 0;
                var rB = window.GM.calculateRallyScore ? window.GM.calculateRallyScore(b) : 0;
                if (rB !== rA) return rB - rA;
                var pB = (parseInt(b.overall_power) || 0) - (parseInt(a.overall_power) || 0);
                if (pB !== 0) return pB;
                var fB = (parseInt(b.flagship_power) || 0) - (parseInt(a.flagship_power) || 0);
                if (fB !== 0) return fB;
                return (parseInt(b.fleet_rating) || 0) - (parseInt(a.fleet_rating) || 0);
            });

            var maxRallyScore = 0;
            var rallyRankMap = {};
            var leaderCount = 0;
            rallyRankedList.forEach(function (m, idx) {
                var pKey = (m.pseudo || '').toLowerCase();
                var rScore = window.GM.calculateRallyScore ? window.GM.calculateRallyScore(m) : 0;
                if (rScore > maxRallyScore) maxRallyScore = rScore;
                if (idx < 16 && rScore > 0) {
                    leaderCount++;
                    rallyRankMap[pKey] = {
                        isLeader: true,
                        rank: idx + 1,
                        label: 'Leader #' + (idx + 1)
                    };
                } else {
                    rallyRankMap[pKey] = {
                        isLeader: false,
                        rank: idx + 1,
                        label: 'Rally Joiner'
                    };
                }
            });

            var totalFleet = 0;
            var totalTech = 0;
            var totalFlagship = 0;
            var totalGlory = 0;
            var totalPower = 0;

            sorted.forEach(function (m) {
                totalFleet += (parseInt(m.fleet_rating) || 0);
                totalTech += (parseInt(m.tech_power) || 0);
                totalFlagship += (parseInt(m.flagship_power) || 0);
                totalGlory += (parseInt(m.glory_score) || 0);
                totalPower += (parseInt(m.overall_power) || 0);
            });

            var headerSummary =
                '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem; margin-bottom:1rem; padding:0.85rem 1rem; background:var(--bg-1); border:1px solid var(--border-soft); border-radius:var(--radius-lg);">' +
                    '<div style="font-weight:700; font-size:0.95rem; color:var(--fg); display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">' +
                        '<span class="material-symbols-rounded" style="color:var(--accent);">shield</span> Tactical Force Matrix (' + sorted.length + ' players)' +
                        '<span class="gm-chip" style="color:#facc15; background:rgba(234,179,8,0.12); border:1px solid rgba(234,179,8,0.3); font-size:0.72rem; margin-left:0.35rem;" title="16 Top Rally Leaders automatically assigned"><i class="ph ph-crown-simple"></i> ' + leaderCount + ' Rally Leaders</span>' +
                        '<span class="gm-chip" style="color:#818cf8; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.3); font-size:0.72rem;"><i class="ph ph-lightning"></i> Sorted by Rally Power</span>' +
                    '</div>' +
                    '<div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">' +
                        '<span class="gm-chip" style="color:#60a5fa; background:rgba(96,165,250,0.12); border:1px solid rgba(96,165,250,0.3); font-size:0.75rem;"><i class="ph ph-swords"></i> Guild Fleet: ' + window.GM.formatPower(totalFleet) + '</span>' +
                        '<span class="gm-chip" style="color:#a78bfa; background:rgba(167,139,250,0.12); border:1px solid rgba(167,139,250,0.3); font-size:0.75rem;"><i class="ph ph-atom"></i> Guild Tech: ' + window.GM.formatPower(totalTech) + '</span>' +
                        '<span class="gm-chip" style="color:#34d399; background:rgba(52,211,153,0.12); border:1px solid rgba(52,211,153,0.3); font-size:0.75rem;" title="Sum of latest recorded Sunday Glory across active roster"><i class="ph ph-trophy"></i> Total Glory: ' + window.GM.formatPower(totalGlory) + '</span>' +
                    '</div>' +
                '</div>';

            var eligibleInList = list.filter(function (m) { return m && m.pseudo && m.role !== 'R5'; });
            var allMatrixSelected = withActions && eligibleInList.length > 0 && eligibleInList.every(function (m) {
                return window.adminSelectedMembers && window.adminSelectedMembers.has(m.pseudo);
            });

            var rowsHtml = sorted.map(function (m) {
                var initial = window.GM.avatarInit(m.pseudo);
                var uidVal = m.uid || '-';
                var roleVal = m.role || 'R1';
                var powerVal = parseInt(m.overall_power) || 0;
                var density = window.GM.calculateCombatDensity ? window.GM.calculateCombatDensity(m) : 0;
                var rallyScore = window.GM.calculateRallyScore ? window.GM.calculateRallyScore(m) : 0;
                var rallyGrade = window.GM.calculateRallyGrade ? window.GM.calculateRallyGrade(m, maxRallyScore) : (maxRallyScore > 0 ? Math.round((rallyScore / maxRallyScore) * 100) : 0);

                var rallyInfo = rallyRankMap[(m.pseudo || '').toLowerCase()] || { isLeader: false, rank: 999, label: 'Rally Joiner' };
                var rallyRoleChip = '';

                if (rallyInfo.isLeader) {
                    if (rallyInfo.rank <= 4) {
                        rallyRoleChip = '<span class="gm-chip" style="background:rgba(234,179,8,0.18); color:#facc15; font-size:0.72rem; font-weight:700; border:1px solid rgba(234,179,8,0.35); padding:0.12rem 0.5rem; gap:0.25rem;" title="Top Tier Rally Leader #' + rallyInfo.rank + '"><i class="ph ph-crown-simple"></i> Leader #' + rallyInfo.rank + '</span>';
                    } else if (rallyInfo.rank <= 8) {
                        rallyRoleChip = '<span class="gm-chip" style="background:rgba(168,85,247,0.18); color:#c084fc; font-size:0.72rem; font-weight:700; border:1px solid rgba(168,85,247,0.35); padding:0.12rem 0.5rem; gap:0.25rem;" title="Elite Rally Leader #' + rallyInfo.rank + '"><i class="ph ph-shield-star"></i> Leader #' + rallyInfo.rank + '</span>';
                    } else {
                        rallyRoleChip = '<span class="gm-chip" style="background:rgba(59,130,246,0.18); color:#60a5fa; font-size:0.72rem; font-weight:700; border:1px solid rgba(59,130,246,0.35); padding:0.12rem 0.5rem; gap:0.25rem;" title="Rally Leader #' + rallyInfo.rank + '"><i class="ph ph-target"></i> Leader #' + rallyInfo.rank + '</span>';
                    }
                } else {
                    rallyRoleChip = '<span class="gm-chip" style="background:rgba(148,163,184,0.12); color:var(--text-muted); font-size:0.7rem; border:1px solid var(--border-soft); padding:0.1rem 0.45rem; gap:0.25rem;" title="Rally Reinforcement / Joiner"><i class="ph ph-users"></i> Rally Joiner</span>';
                }

                var mUidStatus = window.GM && window.GM.getUidStatus ? window.GM.getUidStatus(m.uid) : { valid: true };
                var mUidHtml = !mUidStatus.valid
                    ? '<div style="font-size:0.7rem; margin-top:2px;" class="gm-mono gm-uid-invalid" title="' + esc(mUidStatus.label + ' — ' + (mUidStatus.reason || 'Click Edit to set real game UID')) + '"><i class="ph-bold ph-warning-circle"></i> UID ' + esc(uidVal) + '</div>'
                    : '<div style="font-size:0.7rem; color:var(--text-muted);" class="gm-mono">UID ' + esc(uidVal) + '</div>';

                var isR5 = (roleVal === 'R5');
                var isSelected = withActions && window.adminSelectedMembers && window.adminSelectedMembers.has(m.pseudo);
                var chkHtml = withActions
                    ? '<label class="gm-member-select-chk-wrap" title="' + (isR5 ? (t('bulk_r5_excluded_note') || 'R5 Leader cannot be modified in bulk') : 'Select member') + '">' +
                          '<input type="checkbox" class="gm-member-select-chk admin-member-chk" data-pseudo="' + esc(m.pseudo) + '"' +
                          (isSelected ? ' checked' : '') +
                          (isR5 ? ' disabled' : '') + '>' +
                      '</label>'
                    : '';

                return '<tr class="' + (isSelected ? 'is-selected' : '') + '" style="border-bottom:1px solid var(--border-soft); transition:background 0.15s ease;">' +
                    '<td style="padding:0.65rem 0.75rem;">' +
                        '<div style="display:flex; align-items:center; gap:0.5rem;">' +
                            chkHtml +
                            '<div class="gm-avatar gm-avatar-squircle" style="width:28px; height:28px; font-size:0.75rem;">' + esc(initial) + '</div>' +
                            '<div>' +
                                '<div style="font-weight:600; font-size:0.88rem; color:var(--fg);">' + esc(m.pseudo) + '</div>' +
                                mUidHtml +
                            '</div>' +
                        '</div>' +
                    '</td>' +
                    '<td data-label="Rally" style="padding:0.65rem 0.5rem; text-align:center;">' + rallyRoleChip + '</td>' +
                    '<td data-label="Role" style="padding:0.65rem 0.5rem; text-align:center;"><span class="gm-role-chip" style="font-size:0.7rem; padding:0.1rem 0.35rem;">' + esc(roleVal) + '</span></td>' +
                    '<td data-label="Power" style="padding:0.65rem 0.5rem; text-align:right; font-weight:600; font-size:0.85rem;">' + window.GM.formatPower(powerVal) + '</td>' +
                    '<td data-label="Fleet" style="padding:0.65rem 0.5rem; text-align:right; color:#60a5fa; font-weight:600; font-size:0.85rem;">' + (m.fleet_rating ? window.GM.formatPower(m.fleet_rating) : '<span style="color:var(--text-muted); opacity:0.4;">—</span>') + '</td>' +
                    '<td data-label="Tech" style="padding:0.65rem 0.5rem; text-align:right; color:#a78bfa; font-weight:600; font-size:0.85rem;">' + (m.tech_power ? window.GM.formatPower(m.tech_power) : '<span style="color:var(--text-muted); opacity:0.4;">—</span>') + '</td>' +
                    '<td data-label="Flagship" style="padding:0.65rem 0.5rem; text-align:right; color:#fbbf24; font-weight:600; font-size:0.85rem;">' + (m.flagship_power ? window.GM.formatPower(m.flagship_power) : '<span style="color:var(--text-muted); opacity:0.4;">—</span>') + '</td>' +
                    '<td data-label="Champs" style="padding:0.65rem 0.5rem; text-align:right; color:#f472b6; font-weight:600; font-size:0.85rem;">' + (m.champion_power ? window.GM.formatPower(m.champion_power) : '<span style="color:var(--text-muted); opacity:0.4;">—</span>') + '</td>' +
                    '<td data-label="Crew" style="padding:0.65rem 0.5rem; text-align:right; color:#38bdf8; font-weight:600; font-size:0.85rem;">' + (m.crew_power ? window.GM.formatPower(m.crew_power) : '<span style="color:var(--text-muted); opacity:0.4;">—</span>') + '</td>' +
                    '<td data-label="Glory" style="padding:0.65rem 0.5rem; text-align:right; color:#34d399; font-weight:600; font-size:0.85rem;" title="Latest Recorded Sunday Glory: ' + (m.glory_score ? window.GM.formatNumber(m.glory_score) : '0') + '">' + (m.glory_score ? window.GM.formatPower(m.glory_score) : '<span style="color:var(--text-muted); opacity:0.4;">—</span>') + '</td>' +
                    '<td data-label="Rally Score" style="padding:0.65rem 0.5rem; text-align:center;">' +
                        (rallyScore > 0
                            ? '<span class="gm-chip" style="font-weight:700; font-size:0.8rem; color:#818cf8; background:rgba(99,102,241,0.15); border:1px solid rgba(99,102,241,0.32); padding:0.15rem 0.5rem; gap:0.25rem;" title="Rally Grade: ' + rallyGrade + '/100 (' + window.GM.formatPower(rallyScore) + ')"><i class="ph ph-lightning"></i> ' + rallyGrade + '/100</span>'
                            : '<span style="color:var(--text-muted); opacity:0.4;">—</span>'
                        ) +
                    '</td>' +
                    '<td data-label="Action" style="padding:0.65rem 0.75rem; text-align:center;">' +
                        '<button type="button" class="gm-btn gm-btn-ghost gm-btn-sm guild-edit-btn" data-pseudo="' + esc(m.pseudo) + '" title="Edit Player Military Metrics" style="padding:0.25rem 0.5rem; font-size:0.75rem; gap:0.25rem;"><i class="ph ph-pencil-simple"></i> Edit</button>' +
                    '</td>' +
                '</tr>';
            }).join('');

            return headerSummary +
                '<div class="gm-table-wrap" style="background:var(--bg-1); border:1px solid var(--border-soft); border-radius:var(--radius-lg); overflow-x:auto;">' +
                    '<table class="gm-table gm-resp-table" style="width:100%; border-collapse:collapse; min-width:850px;">' +
                        '<thead>' +
                            '<tr style="background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-soft); font-size:0.72rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted);">' +
                                '<th style="padding:0.65rem 0.75rem; text-align:left;">' +
                                    '<div style="display:flex; align-items:center; gap:0.4rem;">' +
                                        (withActions ? '<label class="gm-member-select-chk-wrap" title="' + (t('bulk_select_all') || 'Select All') + '"><input type="checkbox" class="gm-member-select-chk admin-matrix-select-all-chk"' + (allMatrixSelected ? ' checked' : '') + '></label>' : '') +
                                        '<span>Player</span>' +
                                    '</div>' +
                                '</th>' +
                                '<th style="padding:0.65rem 0.5rem; text-align:center; color:#facc15;" title="Top 16 Rally Leaders vs Rally Joiners">🎯 Rally</th>' +
                                '<th style="padding:0.65rem 0.5rem; text-align:center;">Role</th>' +
                                '<th style="padding:0.65rem 0.5rem; text-align:right;">Power</th>' +
                                '<th style="padding:0.65rem 0.5rem; text-align:right; color:#60a5fa;">⚔️ Fleet</th>' +
                                '<th style="padding:0.65rem 0.5rem; text-align:right; color:#a78bfa;">🔬 Tech</th>' +
                                '<th style="padding:0.65rem 0.5rem; text-align:right; color:#fbbf24;">🚀 Flagship</th>' +
                                '<th style="padding:0.65rem 0.5rem; text-align:right; color:#f472b6;">👑 Champs</th>' +
                                '<th style="padding:0.65rem 0.5rem; text-align:right; color:#38bdf8;">👥 Crew</th>' +
                                '<th style="padding:0.65rem 0.5rem; text-align:right; color:#34d399;" title="Latest Recorded Sunday Glory Score">🏆 Glory</th>' +
                                '<th style="padding:0.65rem 0.5rem; text-align:center; color:#818cf8;" title="Absolute Rally Combat Power & Density Indicator">⚡ Rally Score</th>' +
                                '<th style="padding:0.65rem 0.75rem; text-align:center;">Action</th>' +
                            '</tr>' +
                        '</thead>' +
                        '<tbody>' +
                            rowsHtml +
                        '</tbody>' +
                    '</table>' +
                '</div>';
        }

        if (guildMemberCount)  guildMemberCount.textContent  = filteredAdmin.length;

        // Count members with temporary or invalid UIDs in current active guild
        var tempUidCount = 0;
        guildMembers.forEach(function (m) {
            var memberG = m.guild || 'ALPHA';
            if (memberG === currentG && window.GM && window.GM.isInvalidOrTempUid && window.GM.isInvalidOrTempUid(m.uid)) {
                tempUidCount++;
            }
        });

        var tempUidBadge = document.getElementById('guild-member-temp-uid-badge');
        var tempUidCountSpan = document.getElementById('guild-member-temp-uid-count');
        if (tempUidBadge && tempUidCountSpan) {
            if (tempUidCount > 0) {
                tempUidCountSpan.textContent = tempUidCount;
                tempUidBadge.style.display = 'inline-flex';
                tempUidBadge.setAttribute('title', tempUidCount + ' member(s) with temporary or invalid UID. Click to filter.');
                if (!tempUidBadge.hasAttribute('data-wired')) {
                    tempUidBadge.setAttribute('data-wired', '1');
                    tempUidBadge.addEventListener('click', function () {
                        var tierSelect = document.getElementById('member-tier-filter-admin');
                        if (tierSelect) {
                            tierSelect.value = (tierSelect.value === 'TEMP_UID') ? 'ALL' : 'TEMP_UID';
                            tierSelect.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    });
                }
            } else {
                tempUidBadge.style.display = 'none';
            }
        }

        var viewMode = window.adminMembersViewMode || 'cards';

        if (guildMemberList) {
            if (viewMode === 'matrix') {
                var currentMatrixSort = (sortAdminSelect && sortAdminSelect.value !== 'power_desc') ? sortAdmin : 'rally_desc';
                guildMemberList.innerHTML = buildMilitaryMatrixHtml(filteredAdmin, currentMatrixSort, true, portalUids);
            } else {
                guildMemberList.innerHTML = buildGroupedListHtml(filteredAdmin, sortAdmin, true, portalUids);
            }
        }

        // Update Bulk Action Bar
        updateBulkActionBar(filteredAdmin);

        // Member selection checkboxes
        document.querySelectorAll('.admin-member-chk').forEach(function (chk) {
            chk.addEventListener('change', function () {
                var pseudo = chk.getAttribute('data-pseudo');
                if (!pseudo) return;
                if (chk.checked) {
                    window.adminSelectedMembers.add(pseudo);
                } else {
                    window.adminSelectedMembers.delete(pseudo);
                }
                updateBulkActionBar(filteredAdmin);
                var rowOrCard = chk.closest('.gm-member-row, tr');
                if (rowOrCard) rowOrCard.classList.toggle('is-selected', chk.checked);
            });
        });

        // Matrix Select All checkbox in table header
        var matrixSelectAllChk = document.querySelector('.admin-matrix-select-all-chk');
        if (matrixSelectAllChk) {
            matrixSelectAllChk.addEventListener('change', function () {
                var eligible = filteredAdmin.filter(function (m) { return m && m.pseudo && m.role !== 'R5'; });
                if (matrixSelectAllChk.checked) {
                    eligible.forEach(function (m) { window.adminSelectedMembers.add(m.pseudo); });
                } else {
                    eligible.forEach(function (m) { window.adminSelectedMembers.delete(m.pseudo); });
                }
                renderGuildMembers();
            });
        }

        // Toolbar Select All button
        var selectAllBtn = document.getElementById('admin-members-select-all-btn');
        if (selectAllBtn) {
            selectAllBtn.onclick = function () {
                var eligible = filteredAdmin.filter(function (m) { return m && m.pseudo && m.role !== 'R5'; });
                var allSelected = eligible.length > 0 && eligible.every(function (m) { return window.adminSelectedMembers.has(m.pseudo); });
                if (allSelected) {
                    eligible.forEach(function (m) { window.adminSelectedMembers.delete(m.pseudo); });
                } else {
                    eligible.forEach(function (m) { window.adminSelectedMembers.add(m.pseudo); });
                }
                renderGuildMembers();
            };
        }

        // Bulk action clear button
        var bulkClearBtn = document.getElementById('admin-bulk-clear-btn');
        if (bulkClearBtn) {
            bulkClearBtn.onclick = function () {
                window.adminSelectedMembers.clear();
                renderGuildMembers();
            };
        }

        // Bulk Role Assignment Buttons (R5 strictly excluded)
        document.querySelectorAll('.gm-bulk-role-btn').forEach(function (btn) {
            btn.onclick = async function () {
                var role = btn.getAttribute('data-role');
                await bulkUpdateMemberRoles(role);
            };
        });

        // View mode segmented switcher
        document.querySelectorAll('#admin-members-view-mode .gm-seg-btn').forEach(function (btn) {
            btn.onclick = function () {
                var v = btn.getAttribute('data-view');
                window.adminMembersViewMode = v;
                document.querySelectorAll('#admin-members-view-mode .gm-seg-btn').forEach(function (b) {
                    var isActive = b.getAttribute('data-view') === v;
                    b.classList.toggle('active', isActive);
                    b.style.background = isActive ? 'var(--accent)' : 'transparent';
                    b.style.color = isActive ? '#fff' : 'var(--text-muted)';
                });
                renderGuildMembers();
            };
        });

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

    function updateBulkActionBar(filteredList) {
        var bar = document.getElementById('admin-members-bulk-bar');
        var countSpan = document.getElementById('admin-bulk-selected-count');
        if (!bar || !countSpan) return;

        var activeGuild = window.GM ? window.GM.getActiveGuild() : (window.currentGuildRestriction || window.currentGuild || 'ALPHA');
        var currentRoster = guildMembers.filter(function (m) { return (m.guild || 'ALPHA') === activeGuild; });
        var rosterMap = {};
        currentRoster.forEach(function (m) { if (m && m.pseudo) rosterMap[m.pseudo] = m; });

        // Clean out pseudos that aren't in current active guild roster or are R5
        Array.from(window.adminSelectedMembers).forEach(function (p) {
            var mem = rosterMap[p];
            if (!mem || mem.role === 'R5') {
                window.adminSelectedMembers.delete(p);
            }
        });

        var count = window.adminSelectedMembers.size;
        if (count > 0) {
            var labelText = (t('bulk_selected_count') || '{n} selected').replace('{n}', count);
            countSpan.textContent = labelText;
            bar.style.display = 'block';
            requestAnimationFrame(function () {
                bar.classList.add('is-visible');
            });
        } else {
            bar.classList.remove('is-visible');
            setTimeout(function () {
                if (window.adminSelectedMembers.size === 0) {
                    bar.style.display = 'none';
                }
            }, 280);
        }
        updateSelectAllBtnState(filteredList);
    }

    function updateSelectAllBtnState(filteredList) {
        var selectAllBtn = document.getElementById('admin-members-select-all-btn');
        if (!selectAllBtn) return;
        var eligible = (filteredList || []).filter(function (m) { return m && m.pseudo && m.role !== 'R5'; });
        var allSelected = eligible.length > 0 && eligible.every(function (m) { return window.adminSelectedMembers.has(m.pseudo); });
        var labelSpan = selectAllBtn.querySelector('span');
        var icon = selectAllBtn.querySelector('i');
        if (allSelected) {
            if (labelSpan) labelSpan.textContent = t('bulk_deselect_all') || 'Deselect All';
            if (icon) icon.className = 'ph ph-check-square-offset';
            selectAllBtn.classList.add('active');
        } else {
            if (labelSpan) labelSpan.textContent = t('bulk_select_all') || 'Select All';
            if (icon) icon.className = 'ph ph-check-square';
            selectAllBtn.classList.remove('active');
        }
    }

    async function bulkUpdateMemberRoles(targetRole) {
        if (!window.GM || !window.GM.isRoleAllowedForBulk || !window.GM.isRoleAllowedForBulk(targetRole)) {
            showToast('Invalid role. R5 Leader cannot be assigned in bulk.', 'error');
            return false;
        }

        var activeGuild = window.GM ? window.GM.getActiveGuild() : (window.currentGuildRestriction || window.currentGuild || 'ALPHA');
        var currentRoster = guildMembers.filter(function (m) { return (m.guild || 'ALPHA') === activeGuild; });

        var checkResult = window.GM.filterBulkEligibleMembers(currentRoster, window.adminSelectedMembers);
        var eligible = checkResult.eligiblePseudos;

        if (!eligible || eligible.length === 0) {
            showToast(t('toast_no_members_selected') || 'No eligible members selected', 'error');
            return false;
        }

        try {
            var res = await supabase
                .from('guild_members')
                .update({
                    role: targetRole,
                    metrics_updated_at: new Date().toISOString()
                })
                .eq('guild', activeGuild)
                .in('pseudo', eligible);

            if (res.error) throw res.error;

            var updatedCount = eligible.length;
            window.adminSelectedMembers.clear();
            await fetchGuildMembers();

            var msg = (t('toast_bulk_role_updated') || '{n} member(s) successfully assigned to rank {role}')
                .replace('{n}', updatedCount)
                .replace('{role}', targetRole);
            showToast(msg, 'success');
            return true;
        } catch (err) {
            console.error('bulkUpdateMemberRoles error:', err);
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
            return false;
        }
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
        var isR5 = (roleVal === 'R5');
        var isSelected = withActions && window.adminSelectedMembers && window.adminSelectedMembers.has(m.pseudo);
        var chkHtml = withActions
            ? '<label class="gm-member-select-chk-wrap" title="' + (isR5 ? (t('bulk_r5_excluded_note') || 'R5 Leader cannot be modified in bulk') : 'Select member') + '">' +
                  '<input type="checkbox" class="gm-member-select-chk admin-member-chk" data-pseudo="' + esc(m.pseudo) + '"' +
                  (isSelected ? ' checked' : '') +
                  (isR5 ? ' disabled' : '') + '>' +
              '</label>'
            : '';

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

        var tacticalChips = [];
        if (m.fleet_rating) {
            tacticalChips.push('<span class="gm-chip" style="font-size:0.68rem; color:#60a5fa; background:rgba(96,165,250,0.12); border:1px solid rgba(96,165,250,0.3); padding:0.05rem 0.35rem; border-radius:4px;" title="Fleet Rating: ' + window.GM.formatNumber(m.fleet_rating) + '">⚔️ ' + window.GM.formatPower(m.fleet_rating) + '</span>');
        }
        if (m.tech_power) {
            tacticalChips.push('<span class="gm-chip" style="font-size:0.68rem; color:#a78bfa; background:rgba(167,139,250,0.12); border:1px solid rgba(167,139,250,0.3); padding:0.05rem 0.35rem; border-radius:4px;" title="Tech Power: ' + window.GM.formatNumber(m.tech_power) + '">🔬 ' + window.GM.formatPower(m.tech_power) + '</span>');
        }
        if (m.flagship_power) {
            tacticalChips.push('<span class="gm-chip" style="font-size:0.68rem; color:#fbbf24; background:rgba(251,191,36,0.12); border:1px solid rgba(251,191,36,0.3); padding:0.05rem 0.35rem; border-radius:4px;" title="Flagship Power: ' + window.GM.formatNumber(m.flagship_power) + '">🚀 ' + window.GM.formatPower(m.flagship_power) + '</span>');
        }
        if (m.glory_score) {
            tacticalChips.push('<span class="gm-chip" style="font-size:0.68rem; color:#34d399; background:rgba(52,211,153,0.12); border:1px solid rgba(52,211,153,0.3); padding:0.05rem 0.35rem; border-radius:4px;" title="Glory Score: ' + window.GM.formatNumber(m.glory_score) + '">🏆 ' + window.GM.formatPower(m.glory_score) + '</span>');
        }

        var tacticalHtml = tacticalChips.length
            ? '<div class="gm-member-tactical-row" style="display:flex; gap:0.35rem; flex-wrap:wrap; margin-top:0.25rem;">' + tacticalChips.join('') + '</div>'
            : (withActions
                ? '<div class="gm-member-tactical-row" style="display:flex; gap:0.35rem; flex-wrap:wrap; margin-top:0.25rem;"><button type="button" class="guild-edit-btn" data-pseudo="' + esc(m.pseudo) + '" style="font-size:0.68rem; color:var(--accent); background:rgba(99,102,241,0.08); border:1px dashed rgba(99,102,241,0.3); border-radius:4px; padding:0.05rem 0.4rem; cursor:pointer; display:inline-flex; align-items:center; gap:0.25rem;"><i class="ph ph-plus-circle"></i> + Declare Military Stats</button></div>'
                : '');

        var uidStatus = window.GM && window.GM.getUidStatus ? window.GM.getUidStatus(m.uid) : { valid: true };
        var uidDisplayHtml = !uidStatus.valid
            ? '<span class="gm-mono gm-uid-text gm-uid-invalid" title="' + esc(uidStatus.label + ' — ' + (uidStatus.reason || 'Click Edit to set real game UID')) + '"><i class="ph-bold ph-warning-circle"></i> UID ' + esc(uidVal) + '</span>'
            : '<span class="gm-mono gm-uid-text">UID ' + esc(uidVal) + '</span>';

        return '<div class="gm-member-row' + (isSelected ? ' is-selected' : '') + '" data-pseudo="' + esc(m.pseudo) + '">' +
                '<div class="gm-member-id">' +
                    chkHtml +
                    '<div class="gm-avatar gm-avatar-squircle">' + esc(initial) + '</div>' +
                    '<div class="gm-grow gm-truncate">' +
                        '<div class="gm-member-pseudo-row">' +
                            '<span class="gm-member-pseudo">' + esc(m.pseudo) + '</span>' +
                            roleBadgeHtml +
                            portalBadge +
                            absenceBadge +
                            timezoneChip +
                        '</div>' +
                        '<div class="gm-member-sub-info" style="display:flex; flex-direction:column; gap:0.2rem; align-items:flex-start;">' +
                            '<div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">' +
                                uidDisplayHtml +
                                tierBadge +
                            '</div>' +
                            tacticalHtml +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="gm-member-date">' +
                    '<i class="ph ph-calendar-blank"></i> <span>' + dateStr + '</span>' +
                '</div>' +
                (withActions ? '<div class="gm-member-actions">' +
                    '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm guild-transfer-btn" data-pseudo="' + esc(m.pseudo) + '" data-uid="' + esc(uidVal) + '" title="Transfer member to another eligible guild" style="color: var(--accent);"><i class="ph ph-arrows-left-right"></i></button>' +
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

        // Server-authoritative eligibility: same server, or any server sharing
        // a currently-open cross-server migration group with it. Computed by
        // the backend (gm_list_transfer_eligible_guilds) rather than
        // re-derived client-side, so the UI can never offer an option the
        // transfer RPC itself would reject.
        //
        // Both queries below are independent (neither reads the other's
        // result) so they're kicked off together here and awaited
        // separately, each keeping its own try/catch — a failure fetching
        // the current guild's server number is non-fatal and must not
        // block the dialog from opening.
        var eligPromise = supabase.rpc('gm_list_transfer_eligible_guilds', { p_guild: currentG });
        var curPromise = supabase.from('guilds').select('server_number').eq('id', currentG).maybeSingle();

        var eligibleGuilds = [];
        try {
            var eligRes = await eligPromise;
            if (eligRes.error) throw eligRes.error;
            eligibleGuilds = eligRes.data || [];
        } catch (err) {
            console.error('Failed to fetch transfer-eligible guilds', err);
        }

        if (eligibleGuilds.length === 0) {
            showToast('No other guild is eligible for transfer right now. Set a server number in Super Admin > Subscription Management & Server Numbers, or ask a super admin to open a cross-server migration window.', 'warning');
            return;
        }

        var currentServer = null;
        try {
            var curRes = await curPromise;
            currentServer = curRes.data ? curRes.data.server_number : null;
        } catch (err) {
            console.warn('Failed to fetch current guild server number', err);
        }

        var optionsHtml = eligibleGuilds.map(function (g) {
            var label = g.is_same_server
                ? (g.id + ' (Server #' + g.server_number + ')')
                : (g.id + ' (Server #' + g.server_number + ' — Migration Window)');
            return '<option value="' + esc(g.id) + '" data-server="' + esc(g.server_number) + '">' + esc(label) + '</option>';
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
                            '<label class="gm-label" style="font-size: 0.85rem; font-weight: 600; margin-bottom: 0.35rem; display:block;">Select Target Guild:</label>' +
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

                var targetOption = targetSelect.options[targetSelect.selectedIndex];
                var targetServer = targetOption ? targetOption.getAttribute('data-server') : currentServer;

                closeModal();
                showToast(member.pseudo + ' transferred to ' + targetGuild + ' on Server #' + targetServer + '!', 'success');
                if (window.GM && window.GM.cache) window.GM.cache.invalidate();
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
        overlay.className = 'gm-modal-overlay';

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

        var uidStat = window.GM && window.GM.getUidStatus ? window.GM.getUidStatus(member.uid) : { valid: true };
        var isTempUid = !uidStat.valid;
        var uidHelperHtml = isTempUid
            ? '<div id="edit-uid-helper" style="font-size:0.75rem; color:#f87171; margin-top:0.35rem; display:flex; align-items:center; gap:0.25rem;"><i class="ph ph-warning"></i> ' + esc(uidStat.label) + ' (' + esc(uidStat.reason || 'Enter real 6-10 digit game UID') + ')</div>'
            : '';

        overlay.innerHTML =
            '<div class="gm-modal-card" style="max-width: 480px; width: 95vw;">' +
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
                            '<input type="text" id="edit-uid" value="' + esc(member.uid || '') + '" placeholder="e.g. 1917131" ' + (isTempUid ? 'style="border-color:rgba(239,68,68,0.7);"' : '') + '>' +
                        '</div>' +
                        uidHelperHtml +
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
                    '<div style="background: var(--bg-dim); border: 1px solid var(--border-soft); border-radius: var(--radius-md); padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem;">' +
                        '<div style="font-size: 0.8rem; font-weight: 700; color: var(--accent); display: flex; align-items: center; gap: 0.35rem;"><i class="ph ph-crosshair"></i> Tactical Military Scores</div>' +
                        '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.5rem;">' +
                            '<div class="input-group">' +
                                '<label for="edit-fleet" style="font-size:0.75rem;">⚔️ Fleet Rating</label>' +
                                '<input type="number" id="edit-fleet" class="gm-input" value="' + esc(member.fleet_rating || '') + '" placeholder="e.g. 2000000" style="padding:0.35rem 0.5rem; font-size:0.82rem;">' +
                            '</div>' +
                            '<div class="input-group">' +
                                '<label for="edit-tech" style="font-size:0.75rem;">🔬 Tech Power</label>' +
                                '<input type="number" id="edit-tech" class="gm-input" value="' + esc(member.tech_power || '') + '" placeholder="e.g. 15000000" style="padding:0.35rem 0.5rem; font-size:0.82rem;">' +
                            '</div>' +
                            '<div class="input-group">' +
                                '<label for="edit-flagship" style="font-size:0.75rem;">🚀 Flagship Power</label>' +
                                '<input type="number" id="edit-flagship" class="gm-input" value="' + esc(member.flagship_power || '') + '" placeholder="e.g. 10000000" style="padding:0.35rem 0.5rem; font-size:0.82rem;">' +
                            '</div>' +
                            '<div class="input-group">' +
                                '<label for="edit-champ" style="font-size:0.75rem;">👑 Champions Power</label>' +
                                '<input type="number" id="edit-champ" class="gm-input" value="' + esc(member.champion_power || '') + '" placeholder="e.g. 30000000" style="padding:0.35rem 0.5rem; font-size:0.82rem;">' +
                            '</div>' +
                            '<div class="input-group">' +
                                '<label for="edit-crew" style="font-size:0.75rem;">👥 Crew Power</label>' +
                                '<input type="number" id="edit-crew" class="gm-input" value="' + esc(member.crew_power || '') + '" placeholder="e.g. 5000000" style="padding:0.35rem 0.5rem; font-size:0.82rem;">' +
                            '</div>' +
                            '<div class="input-group">' +
                                '<label for="edit-glory" style="font-size:0.75rem;">🏆 Glory Score</label>' +
                                '<input type="number" id="edit-glory" class="gm-input" value="' + esc(member.glory_score || '') + '" placeholder="e.g. 50000000" style="padding:0.35rem 0.5rem; font-size:0.82rem;">' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                    historyHtml +
                    '<div class="confirm-actions">' +
                        '<button type="button" id="edit-cancel" class="gm-btn gm-btn-ghost">' + t('confirm_cancel') + '</button>' +
                        '<button type="submit" class="gm-btn gm-btn-primary">' + t('confirm_ok') + '</button>' +
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

        var editUidInput = document.getElementById('edit-uid');
        if (editUidInput) {
            editUidInput.addEventListener('input', function () {
                var v = editUidInput.value.trim();
                var st = window.GM && window.GM.getUidStatus ? window.GM.getUidStatus(v) : { valid: true };
                var helper = document.getElementById('edit-uid-helper');
                if (!st.valid) {
                    editUidInput.style.borderColor = 'rgba(239,68,68,0.7)';
                    if (helper) {
                        helper.style.display = 'flex';
                        helper.innerHTML = '<i class="ph ph-warning"></i> ' + esc(st.label) + ' (' + esc(st.reason || 'Enter real 6-10 digit game UID') + ')';
                    }
                } else {
                    editUidInput.style.borderColor = 'rgba(52,211,153,0.7)';
                    if (helper) {
                        helper.style.display = 'none';
                    }
                }
            });
        }

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
            var extraMetrics = {
                fleet_rating:   parseInt(document.getElementById('edit-fleet').value) || 0,
                tech_power:     parseInt(document.getElementById('edit-tech').value) || 0,
                flagship_power: parseInt(document.getElementById('edit-flagship').value) || 0,
                champion_power: parseInt(document.getElementById('edit-champ').value) || 0,
                crew_power:     parseInt(document.getElementById('edit-crew').value) || 0,
                glory_score:    parseInt(document.getElementById('edit-glory').value) || 0
            };
            var ok = await renameGuildMember(member.pseudo, newPseudo, newUid, newPower, newRole, extraMetrics);
            if (ok) close();
        });
    }

    // ─── Confirm Dialog ───────────────────────────────────────────────────────
    function showConfirm(title, message, onConfirm) {
        var existing = document.getElementById('confirm-overlay');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'confirm-overlay';
        overlay.className = 'gm-modal-overlay';
        overlay.innerHTML =
            '<div class="gm-modal-card" style="max-width: 400px; width: 90%; text-align: center;">' +
                '<div class="confirm-icon"><i class="ph-fill ph-warning text-error"></i></div>' +
                '<h3>' + esc(title) + '</h3>' +
                '<p>' + message + '</p>' +
                '<div class="confirm-actions">' +
                    '<button id="confirm-cancel" class="gm-btn gm-btn-ghost">' + t('confirm_cancel') + '</button>' +
                    '<button id="confirm-ok" class="gm-btn gm-btn-danger">' + t('confirm_ok') + '</button>' +
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
        overlay.className = 'gm-modal-overlay';

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

    var goToPortalBtn = document.getElementById('go-to-portal-btn');
    if (goToPortalBtn) {
        goToPortalBtn.addEventListener('click', function () {
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
    }

    var portalGoRegisterBtn = document.getElementById('portal-go-register-btn');
    if (portalGoRegisterBtn) {
        portalGoRegisterBtn.addEventListener('click', function () {
            playerPortalView.classList.add('hidden');
            playerPortalView.classList.remove('portal-connected');
            loginView.classList.remove('hidden');
            showRegisterForm(true);
            var portalContainer = document.querySelector('.gm-portal-container');
            if (portalContainer) portalContainer.classList.remove('portal-wide');
        });
    }

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

    // Shared post-login step for the standalone Player Submission Portal
    // entry (distinct from handleSuccessfulLogin, which drives the main
    // #login-form → full admin/portal dashboard). `loginResp` is whatever
    // window.GM.login()/loginWithPasskey()/loginWithBackupCode() resolved
    // to — all three share the same {ok, id, hasPasskey, ...} shape.
    async function handlePortalLookupSuccess(loginResp, typedId) {
        var id = loginResp.id || typedId;

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
    }

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
            await handlePortalLookupSuccess(loginResp, id);
        } catch (err) {
            console.error(err);
            portalLookupError.querySelector('span').textContent = 'An error occurred during verification.';
            portalLookupError.classList.remove('hidden');
        } finally {
            portalLookupBtn.disabled = false;
            if (span) span.textContent = origText;
        }
    });

    // ─── Passkey / backup-code sign-in — both login screens ────────────────
    // Each button below runs a WebAuthn ceremony (or redeems a backup code)
    // through gm-webauthn.js, then feeds the result into whichever
    // success-handling path matches the screen it's on.
    function wirePasskeyLoginButton(btnId, idInputId, errorElId, onSuccess) {
        var btn = document.getElementById(btnId);
        if (!btn) return;
        if (window.GM.webauthn && !window.GM.webauthn.isSupported()) {
            btn.disabled = true;
            btn.title = 'Passkeys are not supported in this browser.';
        }
        btn.addEventListener('click', async function () {
            var idInput = document.getElementById(idInputId);
            var id = idInput ? idInput.value.trim() : '';
            var errorEl = errorElId ? document.getElementById(errorElId) : null;
            // id is optional: leaving the identifier field blank triggers a
            // fully discoverable ceremony (the browser's native picker shows
            // every passkey registered for this site across every account —
            // needed for someone whose passkeys are spread across more than
            // one account, e.g. a super_admin account and a separate Player
            // Portal account). Typing an id first still narrows the picker
            // to just that one account.

            btn.disabled = true;
            var icon = btn.querySelector('i');
            var originalIconClass = icon ? icon.className : '';
            if (icon) icon.className = 'ph ph-circle-notch ph-spin';
            try {
                var resp = await window.GM.loginWithPasskey(id);
                if (!resp.ok) {
                    if (resp.error === 'cancelled') {
                        // User closed the browser's own passkey prompt — not an error.
                    } else if (errorEl) {
                        var msg = resp.error === 'no_passkeys'
                            ? 'No passkey found for this account.'
                            : resp.error === 'account_locked'
                                ? 'This account is temporarily locked.'
                                : 'Passkey sign-in failed.';
                        errorEl.querySelector('span:last-of-type').textContent = msg;
                        errorEl.classList.remove('hidden');
                    }
                    return;
                }
                if (errorEl) errorEl.classList.add('hidden');
                await onSuccess(resp, id);
            } finally {
                btn.disabled = false;
                if (icon) icon.className = originalIconClass;
            }
        });
    }

    function openBackupCodeDialog(idInputId, onSuccess) {
        var existing = document.getElementById('backup-code-login-overlay');
        if (existing) existing.remove();

        var prefilledId = (document.getElementById(idInputId) || {}).value || '';

        var html =
            '<div id="backup-code-login-overlay" class="gm-modal-overlay">' +
                '<div class="gm-modal-card" style="max-width: 380px; width: 92%;">' +
                    '<div class="gm-modal-header" style="display:flex; align-items:center; gap:.5rem; margin-bottom: .75rem;">' +
                        '<i class="ph ph-key" style="font-size: 1.4rem; color: var(--accent);"></i>' +
                        '<h3 style="margin:0; font-size: 1.1rem;">Use a Backup Code</h3>' +
                    '</div>' +
                    '<div class="gm-login-field">' +
                        '<label for="backup-code-login-id">Identifier</label>' +
                        '<input type="text" id="backup-code-login-id" class="gm-input" value="' + prefilledId.replace(/"/g, '&quot;') + '" autocomplete="username">' +
                    '</div>' +
                    '<div class="gm-login-field" style="margin-top:.6rem;">' +
                        '<label for="backup-code-login-code">Backup code</label>' +
                        '<input type="text" id="backup-code-login-code" class="gm-input" placeholder="XXXXX-XXXXX" autocomplete="one-time-code">' +
                    '</div>' +
                    '<div id="backup-code-login-error" class="gm-login-error hidden" style="margin-top:.6rem;">' +
                        '<i class="ph ph-warning-circle"></i><span></span>' +
                    '</div>' +
                    '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:.5rem; margin-top:1rem;">' +
                        '<button type="button" class="gm-btn gm-btn-ghost" id="backup-code-login-cancel">Cancel</button>' +
                        '<button type="button" class="gm-btn gm-btn-primary" id="backup-code-login-submit">Sign in</button>' +
                    '</div>' +
                '</div>' +
            '</div>';

        document.body.insertAdjacentHTML('beforeend', html);
        var overlay = document.getElementById('backup-code-login-overlay');
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        function closeModal() {
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 200);
        }
        document.getElementById('backup-code-login-cancel').addEventListener('click', closeModal);
        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeModal(); });

        document.getElementById('backup-code-login-submit').addEventListener('click', async function () {
            var id = document.getElementById('backup-code-login-id').value.trim();
            var code = document.getElementById('backup-code-login-code').value.trim();
            var errorEl = document.getElementById('backup-code-login-error');
            if (!id || !code) {
                errorEl.querySelector('span:last-of-type').textContent = 'Enter both your identifier and a backup code.';
                errorEl.classList.remove('hidden');
                return;
            }

            var submitBtn = this;
            submitBtn.disabled = true;
            try {
                var resp = await window.GM.loginWithBackupCode(id, code);
                if (!resp.ok) {
                    var msg = resp.error === 'account_locked'
                        ? 'This account is temporarily locked.'
                        : 'Invalid identifier or backup code.';
                    errorEl.querySelector('span:last-of-type').textContent = msg;
                    errorEl.classList.remove('hidden');
                    return;
                }
                closeModal();
                await onSuccess(resp, id);
            } finally {
                submitBtn.disabled = false;
            }
        });
    }

    wirePasskeyLoginButton('login-passkey-btn', 'username', 'login-error', handleSuccessfulLogin);
    var loginBackupCodeBtn = document.getElementById('login-backup-code-btn');
    if (loginBackupCodeBtn) {
        loginBackupCodeBtn.addEventListener('click', function () {
            openBackupCodeDialog('username', handleSuccessfulLogin);
        });
    }

    wirePasskeyLoginButton('portal-passkey-btn', 'portal-id', 'portal-lookup-error', handlePortalLookupSuccess);
    var portalBackupCodeBtn = document.getElementById('portal-backup-code-btn');
    if (portalBackupCodeBtn) {
        portalBackupCodeBtn.addEventListener('click', function () {
            openBackupCodeDialog('portal-id', handlePortalLookupSuccess);
        });
    }

    // Admin "Player History" modal — opened from clickable Stats leaderboard
    // rows (stats.js). Combines two sources: gm_get_player_metrics_history
    // (power/glory snapshots, already deployed and authorized for admin
    // callers, previously never called from anywhere) and
    // gm_get_player_event_history (event attendance/score, new). Reuses the
    // same canvas chart the player Portal draws its own trend with
    // (window.GM.drawScoreTrendChart) instead of a third implementation.
    async function showPlayerHistoryDialog(uid, pseudo) {
        var existing = document.getElementById('player-history-overlay');
        if (existing) existing.remove();

        var html =
            '<div id="player-history-overlay" class="gm-modal-overlay">' +
                '<div class="gm-modal-card" style="max-width: 640px; width: 92%; position: relative;">' +
                    '<div class="gm-modal-header" style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 1rem;">' +
                        '<div style="display:flex; align-items:center; gap:0.5rem;">' +
                            '<i class="ph ph-chart-line-up" style="font-size: 1.5rem; color: var(--accent);"></i>' +
                            '<h3 style="margin:0; font-size: 1.2rem;">' + esc(pseudo) + ' — Player History</h3>' +
                        '</div>' +
                        '<button type="button" class="gm-mini-btn gm-close-modal"><i class="ph ph-x"></i></button>' +
                    '</div>' +
                    '<div class="gm-modal-body" id="player-history-body" style="display:flex; flex-direction:column; gap:1.25rem; max-height:70vh; overflow-y:auto;">' +
                        '<div class="gm-empty" style="padding:2rem;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading history...</div></div>' +
                    '</div>' +
                    '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top: 1.5rem;">' +
                        '<button type="button" class="gm-btn gm-btn-ghost gm-close-modal">Close</button>' +
                    '</div>' +
                '</div>' +
            '</div>';

        document.body.insertAdjacentHTML('beforeend', html);
        var overlay = document.getElementById('player-history-overlay');
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        function closeModal() {
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 200);
        }
        overlay.querySelectorAll('.gm-close-modal').forEach(function (btn) { btn.addEventListener('click', closeModal); });
        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeModal(); });

        var body = document.getElementById('player-history-body');
        if (!uid) {
            body.innerHTML = '<div class="gm-empty" style="padding:2rem;"><div class="gm-empty-title">No UID on file for this player.</div></div>';
            return;
        }

        try {
            var [metricsRes, eventRes] = await Promise.all([
                supabase.rpc('gm_get_player_metrics_history', { p_uid: uid, p_limit: 12 }),
                supabase.rpc('gm_get_player_event_history', { p_uid: uid, p_limit: 60 })
            ]);

            var metrics = (metricsRes.data && metricsRes.data.ok) ? metricsRes.data : null;
            var eventData = (eventRes.data && eventRes.data.ok) ? eventRes.data : null;
            var powerHistory = (metrics && metrics.history) ? metrics.history : [];

            var sections = '';

            if (powerHistory.length > 0) {
                sections += '<div>' +
                    '<h4 style="margin:0 0 .5rem; font-size:.95rem; color:var(--fg-dim); font-weight:600;">Power trend (last ' + powerHistory.length + ' weeks)</h4>' +
                    '<canvas id="player-history-power-canvas" style="width:100%; display:block;"></canvas>' +
                '</div>';
            }

            var eventKeys = eventData && eventData.events ? Object.keys(eventData.events) : [];
            if (eventKeys.length > 0) {
                sections += '<div>' +
                    '<h4 style="margin:0 0 .5rem; font-size:.95rem; color:var(--fg-dim); font-weight:600;">Event participation</h4>' +
                    '<div style="display:flex; flex-direction:column; gap:.5rem;">' +
                        eventKeys.sort().map(function (evKey) {
                            var ev = eventData.events[evKey];
                            var rateColor = ev.rate >= 80 ? '#34d399' : (ev.rate >= 50 ? '#fbbf24' : 'var(--fg-dim)');
                            return '<div style="display:flex; align-items:center; justify-content:space-between; padding:.6rem .8rem; background:rgba(255,255,255,0.03); border-radius:8px; border:1px solid rgba(255,255,255,0.06);">' +
                                '<span style="font-weight:600;">' + esc(evKey) + '</span>' +
                                '<span style="font-size:.85rem; color:' + rateColor + '; font-weight:700;">' + ev.attended + '/' + ev.count + ' attended (' + ev.rate + '%)</span>' +
                            '</div>';
                        }).join('') +
                    '</div>' +
                '</div>';
            }

            if (!sections) {
                body.innerHTML = '<div class="gm-empty" style="padding:2rem;"><div class="gm-empty-title">No history available for this player.</div></div>';
                return;
            }

            body.innerHTML = sections;

            if (powerHistory.length > 0 && window.GM && window.GM.drawScoreTrendChart) {
                var canvas = document.getElementById('player-history-power-canvas');
                if (canvas) {
                    // gm_get_player_metrics_history returns week_start DESC
                    // (most recent first), matching what drawScoreTrendChart
                    // expects — no guild-average power metric exists here,
                    // so guild_avg_score stays 0 and only the player curve draws.
                    var chartHistory = powerHistory.map(function (h) {
                        return { score: h.total_power, guild_avg_score: 0, week_start: h.week_start };
                    });
                    window.GM.drawScoreTrendChart(canvas, chartHistory);
                }
            }
        } catch (err) {
            console.error('Failed to load player history', err);
            body.innerHTML = '<div class="gm-empty" style="padding:2rem;"><div class="gm-empty-title">Failed to load player history.</div></div>';
        }
    }

    window.GM_APP = window.GM_APP || {};
    window.GM_APP.showToast = showToast;
    window.GM_APP.reloadActiveView = reloadActiveView;
    window.GM_APP.showPlayerHistory = showPlayerHistoryDialog;

})();
