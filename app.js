(function () {

    function t(key) { return window.RAD_I18N.t(key); }
    var supabase = window.RAD ? window.RAD.db : null;
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };

    // ─── CSS Injections ───────────────────────────────────────────────────────
    var style = document.createElement('style');
    style.textContent =
        '@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}' +
        '.text-success{color:var(--success)}' +
        '.ph-spin{animation:spin 1s linear infinite}' +
        '@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);

    // ─── DOM References ───────────────────────────────────────────────────────
    var loginView         = document.getElementById('login-view');
    var dashboardView     = document.getElementById('dashboard-view');
    var memberView        = document.getElementById('member-view');
    var loginForm         = document.getElementById('login-form');
    var loginError        = document.getElementById('login-error');
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

    // ─── Boot ─────────────────────────────────────────────────────────────────
    window.RAD_I18N.applyTranslations();

    // Restaure depuis la session Supabase persistée (survit au rechargement
    // et à la fermeture d'onglet tant que le refresh token est valide).
    (async function restoreSession() {
        var localRole = localStorage.getItem('rad_role');
        var localUser = localStorage.getItem('rad_user');

        // Restauration synchrone immédiate pour éviter le flash de l'écran de connexion
        if (localRole) {
            showAdminDashboard(localRole);
        }

        var info = await window.RAD.sessionInfo();
        if (!info) {
            // Si pas de session valide Supabase mais qu'on avait des infos locales, on force la déconnexion
            if (localRole || localUser) {
                doLogout();
            }
            return;
        }

        // Fetch guild restriction if R4
        if (info.role === 'R4' && info.accountId) {
            try {
                var { data } = await supabase.from('accounts').select('guild').eq('id', info.accountId).maybeSingle();
                if (data && data.guild) {
                    window.currentGuildRestriction = data.guild;
                    window.currentGuild = data.guild;
                    localStorage.setItem('rad_current_guild', data.guild);
                    localStorage.setItem('rad_guild_restriction', data.guild);
                } else {
                    window.currentGuildRestriction = null;
                    localStorage.removeItem('rad_guild_restriction');
                }
            } catch (err) {
                console.error('Failed to restore account guild restriction:', err);
                window.currentGuildRestriction = null;
                localStorage.removeItem('rad_guild_restriction');
            }
        } else {
            window.currentGuildRestriction = null;
            localStorage.removeItem('rad_guild_restriction');
        }

        var role = info.role === 'R5' ? 'admin' : 'member';
        localStorage.setItem('rad_role', role);
        if (info.accountId) {
            localStorage.setItem('rad_user', info.accountId);
        }

        // Fetch guilds list (now authenticated, query will succeed)
        await fetchGuilds();

        // Always update the dashboard and shell to reflect fresh authenticated data
        showAdminDashboard(role);
        if (window.RAD_SHELL && window.RAD_SHELL.renderShell) {
            window.RAD_SHELL.renderShell();
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
            var resp = await window.RAD.login(user, pass);

            if (resp.ok) {
                loginError.classList.add('hidden');
                document.getElementById('password').value = '';

                // Fetch guilds list
                await fetchGuilds();

                // Fetch guild restriction for new logins if R4
                if (resp.role === 'R4') {
                    try {
                        var { data } = await supabase.from('accounts').select('guild').eq('id', user).maybeSingle();
                        if (data && data.guild) {
                            window.currentGuildRestriction = data.guild;
                            window.currentGuild = data.guild;
                            localStorage.setItem('rad_current_guild', data.guild);
                            localStorage.setItem('rad_guild_restriction', data.guild);
                        } else {
                            window.currentGuildRestriction = null;
                            localStorage.removeItem('rad_guild_restriction');
                        }
                    } catch (err) {
                        console.error('Failed to load login guild restriction:', err);
                        window.currentGuildRestriction = null;
                        localStorage.removeItem('rad_guild_restriction');
                    }
                } else {
                    window.currentGuildRestriction = null;
                    localStorage.removeItem('rad_guild_restriction');
                }

                var role = (resp.role === 'R5') ? 'admin' : 'member';
                localStorage.setItem('rad_role', role);
                localStorage.setItem('rad_user', user);

                showAdminDashboard(role);
                if (window.RAD_SHELL && window.RAD_SHELL.renderShell) {
                    window.RAD_SHELL.renderShell();
                }
                showToast(role === 'admin' ? t('toast_login_ok') : (t('toast_welcome') + ' ' + user + ' !'), 'success');
            } else {
                throw new Error('invalid');
            }
        } catch (_) {
            loginError.classList.remove('hidden');
            var card = document.querySelector('.login-card');
            card.style.animation = 'none';
            void card.offsetHeight;
            card.style.animation = 'shake 0.4s ease-in-out';
        } finally {
            btn.disabled = false;
            if (span) span.textContent = t('login_btn');
        }
    });

    if (logoutBtn)       logoutBtn.addEventListener('click', doLogout);
    if (memberLogoutBtn) memberLogoutBtn.addEventListener('click', doLogout);

    function doLogout() {
        window.RAD.logout();
        localStorage.removeItem('rad_role');
        localStorage.removeItem('rad_user');
        localStorage.removeItem('rad_current_guild');
        localStorage.removeItem('rad_guild_restriction');
        window.currentGuildRestriction = null;
        showLogin();
        showToast(t('toast_logout'), 'info');
    }

    // ─── View Switching ───────────────────────────────────────────────────────
    function showAdminDashboard(role) {
        role = role || localStorage.getItem('rad_role');
        loginView.classList.add('hidden');
        if (memberView) memberView.classList.add('hidden');
        dashboardView.classList.remove('hidden');
        dashboardView.classList.add('active');

        var adminHomeBtn = document.querySelector('.nav-tab[data-tab="admin-home"]');
        var adminBannedBtn = document.querySelector('.nav-tab[data-tab="admin-banned"]');
        var roleLabel = document.getElementById('nav-user-role');
        var nameLabel = document.getElementById('nav-user-name');

        var createAccountCard = document.getElementById('create-account-card');
        var activeAccountsCard = document.getElementById('active-accounts-card');
        var createGuildCard = document.getElementById('create-guild-card');

        // Allow both roles (R4/member and R5/admin) to view home & banned tabs
        if (adminHomeBtn) adminHomeBtn.style.display = '';
        if (adminBannedBtn) adminBannedBtn.style.display = '';

        var isR5 = (role !== 'member');
        var activeGuildsCard = document.getElementById('active-guilds-card');

        if (createAccountCard) createAccountCard.style.display = '';
        if (activeAccountsCard) activeAccountsCard.style.display = '';
        if (isR5) {
            if (createGuildCard) createGuildCard.style.display = '';
            if (activeGuildsCard) activeGuildsCard.style.display = '';
            renderGuildsSubscriptionList();
        } else {
            if (createGuildCard) createGuildCard.style.display = 'none';
            if (activeGuildsCard) activeGuildsCard.style.display = 'none';
        }

        var guildSelect = document.getElementById('account-guild');
        if (guildSelect) {
            if (role === 'member') {
                guildSelect.value = window.currentGuildRestriction || '';
                guildSelect.disabled = true;
            } else {
                guildSelect.disabled = false;
            }
        }

        if (role === 'member') { // R4
            if (roleLabel) {
                roleLabel.textContent = window.currentGuildRestriction 
                    ? 'Admin ' + window.currentGuildRestriction + ' :' 
                    : 'Admin :';
            }
            if (nameLabel) nameLabel.textContent = localStorage.getItem('rad_user') || 'Officier';

            loadGuildSettings();
            fetchAccounts();
        } else { // R5
            if (roleLabel) {
                roleLabel.textContent = 'Super Admin :';
            }
            if (nameLabel) nameLabel.textContent = localStorage.getItem('rad_user') || 'Leader';

            fetchAccounts();
            loadGuildSettings();
        }
        // Default landing : Overview (R4 et R5)
        // Retry car gm-overview nav-tab est créé par shell.js après notre code.
        clickWhenReady('.nav-tab[data-tab="gm-overview"]');
    }

    function clickWhenReady(selector, attempts) {
        attempts = attempts == null ? 30 : attempts;
        var el = document.querySelector(selector);
        if (el) { el.click(); return; }
        if (attempts <= 0) return;
        requestAnimationFrame(function () { clickWhenReady(selector, attempts - 1); });
    }

    function showLogin() {
        dashboardView.classList.add('hidden');
        dashboardView.classList.remove('active');
        if (memberView) { memberView.classList.add('hidden'); memberView.classList.remove('active'); }
        loginView.classList.remove('hidden');
        loginView.classList.add('active');
    }

    // ─── Tab Navigation ───────────────────────────────────────────────────────
    document.querySelectorAll('.nav-tab').forEach(function (tabBtn) {
        tabBtn.addEventListener('click', function () {
            var tabId  = tabBtn.getAttribute('data-tab');
            var viewId = tabBtn.getAttribute('data-view');
            var viewEl = document.getElementById(viewId);

            viewEl.querySelectorAll('.nav-tab').forEach(function (b) { b.classList.remove('active'); });
            tabBtn.classList.add('active');

            viewEl.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
            var panel = document.getElementById(tabId);
            if (panel) panel.classList.add('active');

            if (tabId === 'admin-members' || tabId === 'member-members') {
                fetchGuildMembers();
            }
            if (tabId === 'admin-home') {
                fetchAccounts();
                loadGuildSettings();
            }
            if (tabId === 'admin-banned') {
                fetchBannedPlayers();
            }
            var eventName = tabBtn.getAttribute('data-event-tab');
            if (eventName && ['SvS', 'GvG', 'Defend Trade Route'].indexOf(eventName) !== -1 && window.RAD_EVENTS) {
                window.RAD_EVENTS.loadEvent(eventName);
            }
            if (eventName === 'ARMS RACE' && window.RAD_ARMSRACE) {
                window.RAD_ARMSRACE.load();
            }
            if (eventName === 'Shadowfront' && window.RAD_SHADOWFRONT) {
                window.RAD_SHADOWFRONT.load();
            }
            if (eventName === 'stats' && window.RAD_STATS) {
                window.RAD_STATS.load();
            }
            if (eventName === 'glory' && window.RAD_GLORY) {
                window.RAD_GLORY.load();
            }
            if (eventName === 'history' && window.RAD_HISTORY) {
                window.RAD_HISTORY.load();
            }
            if (tabId === 'tab-sanctions' && window.RAD_SANCTIONS) {
                window.RAD_SANCTIONS.load();
            }
            if (tabId === 'gm-overview' && window.RAD_OVERVIEW) {
                window.RAD_OVERVIEW.load();
            }
        });
    });

    // ─── Password Generator ───────────────────────────────────────────────────
    function generatePassword(length) {
        var chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+';
        var pwd = '';
        for (var i = 0; i < length; i++) pwd += chars.charAt(Math.floor(Math.random() * chars.length));
        return pwd;
    }

    // ─── Accounts CRUD ────────────────────────────────────────────────────────
    async function fetchAccounts() {
        if (!supabase) return;
        try {
            var res = await window.RAD.adminAccounts('list');
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
                var res = await window.RAD.adminAccounts('create', {
                    id: identifier,
                    password: newPassword,
                    role: 'R4',
                    guild: (guildSelected === 'ALL' ? null : guildSelected)
                });
                if (!res.ok) throw new Error(res.error || 'create_failed');

                accounts.unshift({ 
                    id: identifier, 
                    password: newPassword, 
                    role: 'R4', 
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
            var res = await window.RAD.adminAccounts('delete', { id: id });
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
            var { data, error } = await supabase.from('guilds').select('id, subscription_type, subscription_end').order('id');
            if (error) throw error;
            console.log('fetchGuilds returned data:', data);
            if (data && data.length > 0) {
                window.guildsList = data.map(function (g) { return g.id; });
                
                // Save subscription info
                window.guildsData = {};
                data.forEach(function (g) {
                    window.guildsData[g.id] = {
                        type: g.subscription_type || 'Unlimited',
                        end: g.subscription_end || null
                    };
                });
                console.log('window.guildsData populated:', window.guildsData);
                
                // Re-render topbar if shell is loaded
                if (window.RAD_SHELL && window.RAD_SHELL.renderTopbar) {
                    window.RAD_SHELL.renderTopbar();
                }
                
                // Update account creation select
                populateAccountGuildSelect();
            }
        } catch (err) {
            console.error('Failed to fetch guilds list', err);
        }
    }

    function populateAccountGuildSelect() {
        var select = document.getElementById('account-guild');
        if (!select) return;
        var currentVal = select.value;
        
        var html = '<option value="ALL">Toutes les guildes (Admin)</option>';
        (window.guildsList || ['ALPHA', 'OMEGA', 'IMK']).forEach(function (g) {
            html += '<option value="' + g + '">' + g + '</option>';
        });
        select.innerHTML = html;
        select.value = currentVal || 'ALL';
    }

    var createGuildForm = document.getElementById('create-guild-form');
    if (createGuildForm) {
        createGuildForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var input = document.getElementById('guild-name-input');
            var guildName = input.value.trim().toUpperCase();
            if (!guildName) return;

            // Simple validation
            if (/[^A-Z0-9_]/.test(guildName)) {
                showToast('Le nom de la guilde ne doit contenir que des lettres majuscules, des chiffres ou des tirets bas.', 'error');
                return;
            }

            if ((window.guildsList || []).indexOf(guildName) !== -1) {
                showToast('Cette guilde existe déjà !', 'error');
                return;
            }

            var btn = e.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            var span = btn.querySelector('span');
            var origText = span ? span.textContent : '';
            if (span) span.textContent = 'Creating...';

            try {
                var { error } = await supabase.from('guilds').insert({ id: guildName });
                if (error) throw error;
                
                showToast('Guild ' + guildName + ' created successfully!', 'success');
                input.value = '';
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

        var coeffSvs = await window.RAD.config.get('coeff_svs');
        var coeffGvg = await window.RAD.config.get('coeff_gvg');
        var coeffShadowfront = await window.RAD.config.get('coeff_shadowfront');
        var coeffDtr = await window.RAD.config.get('coeff_dtr');
        var coeffArmsrace = await window.RAD.config.get('coeff_armsrace');

        // Webhooks configuration
        var webhookArmsrace = await window.RAD.config.get('webhook_armsrace');
        var webhookDtr = await window.RAD.config.get('webhook_dtr');
        var webhookShadowfront = await window.RAD.config.get('webhook_shadowfront');
        var webhookCalamity = await window.RAD.config.get('webhook_calamity');
        var webhookGvg = await window.RAD.config.get('webhook_gvg');
        var webhookSvs = await window.RAD.config.get('webhook_svs');
        var discordRoleId = await window.RAD.config.get('discord_role_id');

        // Notification configs
        var notifyArmsrace30 = await window.RAD.config.get('notify_armsrace_reminder_30');
        var notifyArmsrace5 = await window.RAD.config.get('notify_armsrace_reminder_5');
        var notifyArmsraceStart = await window.RAD.config.get('notify_armsrace_start');

        var notifyDtr30 = await window.RAD.config.get('notify_dtr_reminder_30');
        var notifyDtr5 = await window.RAD.config.get('notify_dtr_reminder_5');
        var notifyDtrStart = await window.RAD.config.get('notify_dtr_start');

        var notifyShadowfront30 = await window.RAD.config.get('notify_shadowfront_reminder_30');
        var notifyShadowfront5 = await window.RAD.config.get('notify_shadowfront_reminder_5');
        var notifyShadowfrontStart = await window.RAD.config.get('notify_shadowfront_start');

        var notifyCalamity10 = await window.RAD.config.get('notify_calamity_10');
        var notifyGvgPvp = await window.RAD.config.get('notify_gvg_pvp');
        
        var notifySvsGarrison = await window.RAD.config.get('notify_svs_garrison');
        var notifySvsPvp = await window.RAD.config.get('notify_svs_pvp');
        var notifySvsWonPrep = await window.RAD.config.get('notify_svs_won_prep');

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

        var setCheckedState = function (id, value, defaultValue) {
            var el = document.getElementById(id);
            if (!el) return;
            if (value === null || value === undefined || value === '') {
                el.checked = defaultValue;
            } else {
                el.checked = (value === 'true' || value === '1');
            }
        };

        setCheckedState('notify-armsrace-30', notifyArmsrace30, true);
        setCheckedState('notify-armsrace-5', notifyArmsrace5, true);
        setCheckedState('notify-armsrace-start', notifyArmsraceStart, true);

        setCheckedState('notify-dtr-30', notifyDtr30, true);
        setCheckedState('notify-dtr-5', notifyDtr5, true);
        setCheckedState('notify-dtr-start', notifyDtrStart, true);

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
                    window.RAD.config.set('coeff_svs', document.getElementById('coeff-svs').value),
                    window.RAD.config.set('coeff_gvg', document.getElementById('coeff-gvg').value),
                    window.RAD.config.set('coeff_shadowfront', document.getElementById('coeff-shadowfront').value),
                    window.RAD.config.set('coeff_dtr', document.getElementById('coeff-dtr').value),
                    window.RAD.config.set('coeff_armsrace', document.getElementById('coeff-armsrace').value),

                    window.RAD.config.set('webhook_armsrace', document.getElementById('webhook-armsrace').value.trim()),
                    window.RAD.config.set('webhook_dtr', document.getElementById('webhook-dtr').value.trim()),
                    window.RAD.config.set('webhook_shadowfront', document.getElementById('webhook-shadowfront').value.trim()),
                    window.RAD.config.set('webhook_calamity', showCalamityGvgSvs ? document.getElementById('webhook-calamity').value.trim() : ''),
                    window.RAD.config.set('webhook_gvg', showCalamityGvgSvs ? document.getElementById('webhook-gvg').value.trim() : ''),
                    window.RAD.config.set('webhook_svs', showCalamityGvgSvs ? document.getElementById('webhook-svs').value.trim() : ''),
                    window.RAD.config.set('discord_role_id', document.getElementById('discord-role-id').value.trim()),

                    // Notification Configs
                    window.RAD.config.set('notify_armsrace_reminder_30', document.getElementById('notify-armsrace-30').checked ? 'true' : 'false'),
                    window.RAD.config.set('notify_armsrace_reminder_5', document.getElementById('notify-armsrace-5').checked ? 'true' : 'false'),
                    window.RAD.config.set('notify_armsrace_start', document.getElementById('notify-armsrace-start').checked ? 'true' : 'false'),

                    window.RAD.config.set('notify_dtr_reminder_30', document.getElementById('notify-dtr-30').checked ? 'true' : 'false'),
                    window.RAD.config.set('notify_dtr_reminder_5', document.getElementById('notify-dtr-5').checked ? 'true' : 'false'),
                    window.RAD.config.set('notify_dtr_start', document.getElementById('notify-dtr-start').checked ? 'true' : 'false'),

                    window.RAD.config.set('notify_shadowfront_reminder_30', document.getElementById('notify-shadowfront-30').checked ? 'true' : 'false'),
                    window.RAD.config.set('notify_shadowfront_reminder_5', document.getElementById('notify-shadowfront-5').checked ? 'true' : 'false'),
                    window.RAD.config.set('notify_shadowfront_start', document.getElementById('notify-shadowfront-start').checked ? 'true' : 'false'),

                    window.RAD.config.set('notify_calamity_10', (showCalamityGvgSvs && document.getElementById('notify-calamity-10').checked) ? 'true' : 'false'),
                    window.RAD.config.set('notify_gvg_pvp', (showCalamityGvgSvs && document.getElementById('notify-gvg-pvp').checked) ? 'true' : 'false'),

                    window.RAD.config.set('notify_svs_garrison', (showCalamityGvgSvs && document.getElementById('notify-svs-garrison').checked) ? 'true' : 'false'),
                    window.RAD.config.set('notify_svs_pvp', (showCalamityGvgSvs && document.getElementById('notify-svs-pvp').checked) ? 'true' : 'false'),
                    window.RAD.config.set('notify_svs_won_prep', (showCalamityGvgSvs && document.getElementById('notify-svs-won-prep').checked) ? 'true' : 'false')
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

    function renderAccounts() {
        if (!accountList) return;
        if (accountCount) accountCount.textContent = accounts.length;
        if (accounts.length === 0) {
            accountList.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_accounts') + '</div></div>';
            return;
        }

        var isSuperAdmin = (localStorage.getItem('rad_role') === 'admin');
        var listToRender = accounts.slice();
        if (isSuperAdmin) {
            listToRender.sort(function (a, b) {
                var gA = a.guild || '';
                var gB = b.guild || '';
                if (gA !== gB) {
                    return gA.localeCompare(gB);
                }
                return a.id.localeCompare(b.id);
            });
        }

        // Cred-grid layout (auto-fill 280px min)
        var html = '<div class="gm-cred-grid">';
        listToRender.forEach(function (acc) {
            // Détermine le rôle pour le chip — si 'role' est dispo, sinon défaut R4
            var role = acc.role || 'R4';
            var roleLabel = role === 'R5' ? 'Super Admin' : 'Admin';
            var chipCls = role === 'R5' ? 'gm-chip-accent' : 'gm-chip-info';
            var dateStr = acc.created_at ? new Date(acc.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' }) : '—';
            var guildLabel = acc.guild ? 'Guilde: ' + acc.guild : 'Toutes les guildes';
            var guildCls = acc.guild ? 'gm-chip-warning' : 'gm-chip-success';

            var isSuperAdminAccount = (role === 'R5');
            var isCurrentUserR4 = (localStorage.getItem('rad_role') === 'member');
            var canManagePass = !(isSuperAdminAccount && isCurrentUserR4);
            var canDelete = !(isSuperAdminAccount && isCurrentUserR4);

            var passHtml = '';
            if (canManagePass) {
                passHtml = '<div class="gm-cred-pass gm-masked" data-acc-pass="' + esc(acc.password) + '">' +
                               '<span class="gm-pwd-text">••••••••••••</span>' +
                               '<button class="gm-mini-btn gm-cred-toggle" title="' + t('show_pwd') + '"><i class="ph ph-eye"></i></button>' +
                               '<button class="gm-mini-btn gm-cred-copy" title="' + t('copy_title') + '"><i class="ph ph-copy"></i></button>' +
                           '</div>';
            } else {
                passHtml = '<div class="gm-cred-pass gm-masked" style="opacity: 0.6; cursor: not-allowed;" title="Non autorisé">' +
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
            if (acc.role !== 'R5' && localStorage.getItem('rad_role') === 'admin') {
                var options = '<option value="ALL"' + (!acc.guild ? ' selected' : '') + '>Toutes</option>';
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
        accountList.innerHTML = html;

        accountList.querySelectorAll('.gm-cred-toggle').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var wrap = btn.closest('.gm-cred-pass');
                var pass = wrap.getAttribute('data-acc-pass');
                var pwdSpan = wrap.querySelector('.gm-pwd-text');
                var icon = btn.querySelector('i');
                if (wrap.classList.contains('gm-masked')) {
                     wrap.classList.remove('gm-masked');
                     pwdSpan.textContent = pass;
                     icon.className = 'ph ph-eye-slash';
                } else {
                     wrap.classList.add('gm-masked');
                     pwdSpan.textContent = '••••••••••••';
                     icon.className = 'ph ph-eye';
                }
            });
        });

        accountList.querySelectorAll('.gm-cred-copy').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var pass = btn.closest('.gm-cred-pass').getAttribute('data-acc-pass');
                navigator.clipboard.writeText(pass).then(function () {
                    var icon = btn.querySelector('i');
                    icon.className = 'ph ph-check';
                    showToast(t('toast_copied'), 'success');
                    setTimeout(function () { icon.className = 'ph ph-copy'; }, 2000);
                });
            });
        });

        accountList.querySelectorAll('.gm-cred-delete').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-id');
                showConfirm(
                    t('confirm_delete_account_title'),
                    t('confirm_delete_account_body') + ' <strong>' + esc(id) + '</strong>' + t('confirm_delete_account_body2'),
                    function () { deleteAccount(id); }
                );
            });
        });

        accountList.querySelectorAll('.gm-account-guild-select').forEach(function (sel) {
            sel.addEventListener('change', async function () {
                var id = sel.getAttribute('data-id');
                var newGuild = sel.value;
                sel.disabled = true;
                try {
                    var res = await window.RAD.adminAccounts('update-guild', { id: id, guild: newGuild });
                    if (!res.ok) throw new Error(res.error || 'update_failed');
                    showToast('Access for ' + id + ' updated successfully!', 'success');
                    
                    var acc = accounts.find(function (a) { return a.id === id; });
                    if (acc) {
                        acc.guild = (newGuild === 'ALL' ? null : newGuild);
                    }
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
            var { data: guildsListRaw, error } = await supabase
                .from('guilds')
                .select('id, subscription_type, subscription_end')
                .order('id');
            if (error) throw error;
            console.log('renderGuildsSubscriptionList fetched data:', guildsListRaw);

            if (!guildsListRaw || guildsListRaw.length === 0) {
                container.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">No guild found</div></div>';
                return;
            }

            var html = '<div class="gm-cred-grid">';
            guildsListRaw.forEach(function (g) {
                var guildId = g.id;
                var type = g.subscription_type || 'Unlimited';
                var end = g.subscription_end;
                var dateVal = end ? end.split('T')[0] : '';

                // Calculate countdown html
                var countdownHtml = '';
                if (type === 'Unlimited') {
                    countdownHtml = '<span class="gm-chip gm-chip-success" style="font-size: 0.75rem; font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;"><i class="ph ph-infinity"></i> Unlimited</span>';
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

                html +=
                    '<div class="gm-cred-card" data-guild-id="' + esc(guildId) + '">' +
                        '<div class="gm-row" style="justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">' +
                            '<div class="gm-cred-name" style="font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem; margin-bottom:0; font-weight:600;">' +
                                '<i class="ph ph-shield"></i> ' + esc(guildId) +
                            '</div>' +
                            '<div class="countdown-badge-wrapper">' + countdownHtml + '</div>' +
                        '</div>' +
                        '<div class="gm-row" style="gap: 0.5rem; align-items: center; flex-wrap: wrap;">' +
                            '<div class="gm-col" style="flex: 1.2; gap: 0.25rem; min-width:120px;">' +
                                '<label class="gm-dim" style="font-size: 0.75rem; margin-bottom:0;">Type</label>' +
                                '<select class="gm-select gm-select-sm guild-sub-type" data-guild="' + esc(guildId) + '" style="padding: 0.25rem 0.5rem; font-size:0.8rem; height: auto;">' +
                                    '<option value="Unlimited"' + (type === 'Unlimited' ? ' selected' : '') + '>Unlimited</option>' +
                                    '<option value="Premium"' + (type === 'Premium' ? ' selected' : '') + '>Premium</option>' +
                                '</select>' +
                            '</div>' +
                            '<div class="gm-col guild-sub-end-wrapper" style="flex: 1.2; gap: 0.25rem; min-width:120px; ' + (type === 'Unlimited' ? 'display: none;' : '') + '">' +
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

                    var type = select.value;
                    var endVal = null;
                    if (type === 'Premium') {
                        if (!input.value) {
                            showToast('Please specify an end date for Premium subscription.', 'error');
                            return;
                        }
                        endVal = new Date(input.value + 'T23:59:59Z').toISOString();
                    }

                    btn.disabled = true;
                    var origText = btn.innerHTML;
                    btn.innerHTML = '<i class="ph ph-circle-notch spinner"></i>...';

                    try {
                        var { error: updateErr } = await supabase
                            .from('guilds')
                            .update({
                                subscription_type: type,
                                subscription_end: endVal
                            })
                            .eq('id', guildId);

                        if (updateErr) throw updateErr;

                        showToast('Subscription updated for guild ' + guildId, 'success');
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

    // ─── Guild Members CRUD ───────────────────────────────────────────────────
    async function fetchGuildMembers() {
        if (!supabase) return;
        try {
            var res = await supabase.from('guild_members').select('*').order('pseudo', { ascending: true });
            if (res.error) throw res.error;
            guildMembers = res.data || [];
            renderGuildMembers();
        } catch (err) {
            showToast(t('toast_err_fetch_members') + ' ' + err.message, 'error');
        }
    }

    async function handleAddMember(inputId, uidInputId, powerInputId) {
        var input  = document.getElementById(inputId);
        var pseudo = input ? input.value.trim() : '';
        var uidInput = document.getElementById(uidInputId);
        var uidVal = uidInput ? uidInput.value.trim() : null;
        var powerInput = powerInputId ? document.getElementById(powerInputId) : null;
        var powerVal = powerInput && powerInput.value ? parseInt(powerInput.value, 10) : NaN;
        if (!pseudo || !uidVal || isNaN(powerVal) || powerVal < 0) {
            showToast('Please enter a valid power value.', 'error');
            return;
        }

        var pseudoErr = window.RAD.validatePseudo(pseudo);
        if (pseudoErr) { showToast(t(pseudoErr), 'error'); return; }
        var uidErr = window.RAD.validateUid(uidVal);
        if (uidErr) { showToast(t(uidErr), 'error'); return; }

        if (guildMembers.some(function (m) { return m.pseudo.toLowerCase() === pseudo.toLowerCase(); })) {
            showToast(t('toast_duplicate_member'), 'error');
            return;
        }
        if (guildMembers.some(function (m) { return m.uid && String(m.uid).trim() === String(uidVal).trim(); })) {
            showToast(t('toast_duplicate_uid'), 'error');
            return;
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
            var res = await supabase.from('guild_members').insert([{ pseudo: pseudo, uid: uidVal, overall_power: powerVal }]);
            if (res.error) throw res.error;
            guildMembers.push({ pseudo: pseudo, uid: uidVal, overall_power: powerVal, created_at: new Date().toISOString() });
            if (input) input.value = '';
            if (uidInput) uidInput.value = '';
            if (powerInput) powerInput.value = '';
            renderGuildMembers();
            showToast(pseudo + ' ' + t('toast_member_added'), 'success');

            var addedEvents = 0;
            if (window.RAD_EVENTS && window.RAD_EVENTS.addMemberToActiveEvents) {
                addedEvents += await window.RAD_EVENTS.addMemberToActiveEvents(pseudo);
            }
            if (window.RAD_ARMSRACE && window.RAD_ARMSRACE.addMemberToActiveEvents) {
                addedEvents += await window.RAD_ARMSRACE.addMemberToActiveEvents(pseudo);
            }
            if (window.RAD_SHADOWFRONT && window.RAD_SHADOWFRONT.load) {
                await window.RAD_SHADOWFRONT.load();
            }
            if (addedEvents > 0) {
                showToast(pseudo + ' ' + t('toast_member_added_active_events'), 'info');
            }
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    if (addMemberForm)  addMemberForm.addEventListener('submit', function (e)  { e.preventDefault(); handleAddMember('member-pseudo', 'member-uid', 'member-power'); });
    if (addMemberFormM) addMemberFormM.addEventListener('submit', function (e) { e.preventDefault(); handleAddMember('member-pseudo-m', 'member-uid-m', 'member-power-m'); });
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

            if (window.RAD_EVENTS && window.RAD_EVENTS.removeMemberFromActiveEvents) {
                window.RAD_EVENTS.removeMemberFromActiveEvents(pseudo);
            }
            if (window.RAD_ARMSRACE && window.RAD_ARMSRACE.removeMemberFromActiveEvents) {
                window.RAD_ARMSRACE.removeMemberFromActiveEvents(pseudo);
            }
            if (window.RAD_SHADOWFRONT && window.RAD_SHADOWFRONT.load) {
                await window.RAD_SHADOWFRONT.load();
            }
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    // ─── Banned Players CRUD ───────────────────────────────────────────────────
    async function fetchBannedPlayers() {
        if (!supabase) return;
        try {
            var res = await supabase.from('banned_players').select('*').order('created_at', { ascending: false });
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
        var lang = (window.RAD_I18N && window.RAD_I18N.getLang) ? window.RAD_I18N.getLang() : 'en';
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
            var initial = window.RAD.avatarInit(pseudoVal !== '—' ? pseudoVal : fallbackName);
            
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

        var uidErr = window.RAD.validateUid(uidVal);
        if (uidErr) { showToast(t(uidErr), 'error'); return; }

        if (bannedPlayers.some(function (bp) { return bp.uid === uidVal; })) {
            showToast(t('toast_player_already_banned'), 'error');
            return;
        }

        var btn = addBannedForm.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;

        try {
            var currentUser = localStorage.getItem('rad_user') || 'Admin';
            var res = await supabase.from('banned_players').insert([{
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
                var delRes = await supabase.from('guild_members').delete().eq('uid', uidVal);
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
            var res = await supabase.from('banned_players').delete().eq('uid', uid);
            if (res.error) throw res.error;
            showToast(t('toast_player_unbanned_ok'), 'success');
            await fetchBannedPlayers();
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    async function renameGuildMember(oldPseudo, newPseudo, newUid, newPower) {
        newPseudo = (newPseudo || '').trim();
        newUid    = (newUid || '').trim();
        var powerVal = parseInt(newPower) || 0;

        var pseudoErr = window.RAD.validatePseudo(newPseudo);
        if (pseudoErr) { showToast(t(pseudoErr), 'error'); return false; }
        var uidErr = window.RAD.validateUid(newUid);
        if (uidErr) { showToast(t(uidErr), 'error'); return false; }

        var member = guildMembers.find(function (m) { return m.pseudo === oldPseudo; });
        var oldPower = member ? parseInt(member.overall_power) || 0 : 0;

        var pseudoChanged = newPseudo.toLowerCase() !== oldPseudo.toLowerCase();
        var uidChanged    = member && (member.uid || '') !== newUid;
        var powerChanged  = oldPower !== powerVal;

        if (!pseudoChanged && !uidChanged && !powerChanged) return true;

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
                    changed_by: localStorage.getItem('rad_user') || 'Admin'
                });
                if (histIns.error) console.error('Logging name history failed', histIns.error);
            }

            var update = {};
            if (pseudoChanged) update.pseudo = newPseudo;
            if (uidChanged)    update.uid = newUid || null;
            update.overall_power = powerVal;

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
        var sortAdmin  = sortAdminSelect  ? sortAdminSelect.value  : 'pseudo_asc';
        var sortMember = sortMemberSelect ? sortMemberSelect.value : 'pseudo_asc';

        var powers = guildMembers.map(function (m) { return parseInt(m.overall_power) || 0; });
        var maxPower = powers.length ? Math.max.apply(null, powers) : 0;

        var filteredAdmin = guildMembers.filter(function (m) {
            var matchSearch = (m.pseudo.toLowerCase() + ' ' + (m.uid || '').toLowerCase()).indexOf(qAdmin) !== -1;
            var matchTier = (tAdmin === 'ALL') || (window.RAD.getPowerTier(m.overall_power, maxPower) === tAdmin);
            return matchSearch && matchTier;
        });
        var filteredMember = guildMembers.filter(function (m) {
            var matchSearch = (m.pseudo.toLowerCase() + ' ' + (m.uid || '').toLowerCase()).indexOf(qMember) !== -1;
            var matchTier = (tMember === 'ALL') || (window.RAD.getPowerTier(m.overall_power, maxPower) === tMember);
            return matchSearch && matchTier;
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

        var sortedAdmin  = sortMembers(filteredAdmin, sortAdmin);
        var sortedMember = sortMembers(filteredMember, sortMember);

        if (guildMemberCount)  guildMemberCount.textContent  = filteredAdmin.length;
        if (guildMemberCountM) guildMemberCountM.textContent = filteredMember.length;

        if (guildMemberList) {
            guildMemberList.innerHTML = sortedAdmin.length
                ? '<div class="gm-member-list">' + sortedAdmin.map(function (m, i) { return memberTileHtml(m, i, true, maxPower); }).join('') + '</div>'
                : '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
        }
        if (guildMemberListM) {
            guildMemberListM.innerHTML = sortedMember.length
                ? '<div class="gm-member-list">' + sortedMember.map(function (m, i) { return memberTileHtml(m, i, false, maxPower); }).join('') + '</div>'
                : '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
        }

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
        var lang = (window.RAD_I18N && window.RAD_I18N.getLang) ? window.RAD_I18N.getLang() : 'en';
        var locale = lang === 'fr' ? 'fr-FR' : 'en-GB';
        var uidVal = m.uid || '—';
        var dateStr = m.created_at
            ? new Date(m.created_at).toLocaleDateString(locale, { day:'2-digit', month:'2-digit', year:'numeric' })
            : '—';
        var initial = window.RAD.avatarInit(m.pseudo);

        var powerVal = parseInt(m.overall_power) || 0;
        var tier = window.RAD.getPowerTier(powerVal, maxPower);
        var meta = window.RAD.getPowerTierMeta(tier);
        var formattedPower = window.RAD.formatPower(powerVal);

        var tierBadge = '<span class="gm-chip ' + meta.cls + '" style="font-size:0.75rem; padding:0.15rem 0.4rem; color:' + meta.color + '; border: 1px solid ' + meta.color + '33; background: ' + meta.color + '0a; display: inline-flex; align-items: center; gap: 0.25rem;" title="' + meta.label + ' Tier"><span style="font-size: 0.8rem;">' + meta.icon + '</span> ' + formattedPower + '</span>';

        return '<div class="gm-member-row" data-pseudo="' + esc(m.pseudo) + '">' +
                '<div class="gm-member-id">' +
                    '<div class="gm-avatar">' + esc(initial) + '</div>' +
                    '<div class="gm-grow gm-truncate">' +
                        '<div class="gm-member-pseudo gm-truncate">' + esc(m.pseudo) + '</div>' +
                        '<div class="gm-row" style="gap:.5rem; margin-top:4px; flex-wrap: wrap;">' +
                            '<span class="gm-dim gm-mono" style="font-size:.78rem;">UID ' + esc(uidVal) + '</span>' +
                            tierBadge +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="gm-row gm-dim" style="gap:.75rem; font-size:.8rem;">' +
                    '<span class="gm-row" style="gap:.3rem;"><i class="ph ph-calendar-blank"></i> ' + dateStr + '</span>' +
                '</div>' +
                (withActions ? '<div class="gm-member-actions">' +
                    '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm guild-edit-btn" data-pseudo="' + esc(m.pseudo) + '" title="' + t('edit_title') + '"><i class="ph ph-pencil-simple"></i></button>' +
                    '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm guild-delete-btn" data-pseudo="' + esc(m.pseudo) + '" title="' + t('delete_title') + '" style="color: var(--danger);"><i class="ph ph-trash"></i></button>' +
                '</div>' : '') +
            '</div>';
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
                    '<div class="input-group">' +
                        '<label for="edit-power">Overall Power</label>' +
                        '<div class="input-wrapper">' +
                            '<i class="ph ph-sword"></i>' +
                            '<input type="number" id="edit-power" value="' + esc(member.overall_power || '') + '" placeholder="e.g. 80000000">' +
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
            var ok = await renameGuildMember(member.pseudo, newPseudo, newUid, newPower);
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
        var tabId = activePanel.id;

        if (tabId === 'admin-members' || tabId === 'member-members') {
            fetchGuildMembers();
        }
        if (tabId === 'admin-home') {
            fetchAccounts();
            loadGuildSettings();
        }
        if (tabId === 'admin-banned') {
            fetchBannedPlayers();
        }
        var activeTabBtn = document.querySelector('.nav-tab.active');
        var eventName = activeTabBtn ? activeTabBtn.getAttribute('data-event-tab') : null;
        if (eventName && ['SvS', 'GvG', 'Defend Trade Route'].indexOf(eventName) !== -1 && window.RAD_EVENTS) {
            window.RAD_EVENTS.loadEvent(eventName);
        }
        if (eventName === 'ARMS RACE' && window.RAD_ARMSRACE) {
            window.RAD_ARMSRACE.load();
        }
        if (eventName === 'Shadowfront' && window.RAD_SHADOWFRONT) {
            window.RAD_SHADOWFRONT.load();
        }
        if (eventName === 'stats' && window.RAD_STATS) {
            window.RAD_STATS.load();
        }
        if (eventName === 'glory' && window.RAD_GLORY) {
            window.RAD_GLORY.load();
        }
        if (eventName === 'history' && window.RAD_HISTORY) {
            window.RAD_HISTORY.load();
        }
        if (tabId === 'tab-sanctions' && window.RAD_SANCTIONS) {
            window.RAD_SANCTIONS.load();
        }
        if (tabId === 'gm-overview' && window.RAD_OVERVIEW) {
            window.RAD_OVERVIEW.load();
        }
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
            templates[r.key + '_content'] = await window.RAD.config.get('tpl_' + eventPrefix + '_' + r.key + '_content') || '';
            templates[r.key + '_title'] = await window.RAD.config.get('tpl_' + eventPrefix + '_' + r.key + '_title') || '';
            templates[r.key + '_desc'] = await window.RAD.config.get('tpl_' + eventPrefix + '_' + r.key + '_desc') || '';
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

        var esc = window.RAD.escapeHTML;

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

                    promises.push(window.RAD.config.set('tpl_' + eventPrefix + '_' + r.key + '_content', valContent));
                    promises.push(window.RAD.config.set('tpl_' + eventPrefix + '_' + r.key + '_title', valTitle));
                    promises.push(window.RAD.config.set('tpl_' + eventPrefix + '_' + r.key + '_desc', valDesc));
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
    var portalUidInput   = document.getElementById('portal-uid');
    var portalLookupError = document.getElementById('portal-lookup-error');
    var portalLookupBtn  = document.getElementById('portal-lookup-btn');
    var portalActiveUid  = null;

    document.getElementById('go-to-portal-btn').addEventListener('click', function () {
        loginView.classList.add('hidden');
        playerPortalView.classList.remove('hidden');
        portalStepLookup.classList.remove('hidden');
        portalStepForm.classList.add('hidden');
        portalLookupError.classList.add('hidden');
        portalUidInput.value = '';
        portalActiveUid = null;
    });

    document.querySelectorAll('.portal-back-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            playerPortalView.classList.add('hidden');
            loginView.classList.remove('hidden');
        });
    });

    portalLookupBtn.addEventListener('click', async function () {
        var uid = portalUidInput.value.trim();
        if (!uid) return;

        portalLookupBtn.disabled = true;
        var span = portalLookupBtn.querySelector('span');
        var origText = span ? span.textContent : '';
        if (span) span.textContent = 'Searching...';
        portalLookupError.classList.add('hidden');

        try {
            var { data, error } = await supabase.functions.invoke('member-portal', {
                body: { action: 'get-active-sessions', payload: { uid: uid } }
            });

            if (error || !data || !data.ok) {
                portalLookupError.querySelector('span').textContent = 'Unable to connect to the portal. Please try again.';
                portalLookupError.classList.remove('hidden');
                return;
            }

            if (data.error === 'player_not_found') {
                portalLookupError.querySelector('span').textContent = 'Player UID not found in guild database.';
                portalLookupError.classList.remove('hidden');
                return;
            }

            // Successfully fetched data
            portalActiveUid = uid;
            portalStepLookup.classList.add('hidden');
            portalStepForm.classList.remove('hidden');

            document.getElementById('portal-user-pseudo').textContent = data.pseudo;
            document.getElementById('portal-user-guild').textContent = data.guild;

            // Pre-populate combat power
            var powerInputEl = document.getElementById('portal-user-power');
            if (powerInputEl) {
                powerInputEl.value = data.overall_power || '';
            }
            
            var initials = window.RAD.avatarInit(data.pseudo);
            var avatarEl = document.getElementById('portal-user-avatar');
            avatarEl.textContent = initials;
            avatarEl.className = 'gm-avatar gm-avatar-md gm-avatar-accent';

            renderPortalActiveSessions(uid, data.sessions);
        } catch (err) {
            console.error(err);
            portalLookupError.querySelector('span').textContent = 'An error occurred during verification.';
            portalLookupError.classList.remove('hidden');
        } finally {
            portalLookupBtn.disabled = false;
            if (span) span.textContent = origText;
        }
    });

    var portalUpdatePowerBtn = document.getElementById('portal-update-power-btn');
    if (portalUpdatePowerBtn) {
        portalUpdatePowerBtn.addEventListener('click', async function () {
            var powerInputEl = document.getElementById('portal-user-power');
            var powerVal = powerInputEl ? parseInt(powerInputEl.value, 10) : 0;
            if (isNaN(powerVal) || powerVal < 0) {
                showToast('Please enter a valid power number.', 'error');
                return;
            }
            if (!portalActiveUid) return;

            portalUpdatePowerBtn.disabled = true;
            var origText = portalUpdatePowerBtn.innerHTML;
            portalUpdatePowerBtn.innerHTML = '<i class="ph ph-circle-notch animate-spin"></i> Saving...';

            try {
                var { data, error } = await supabase.functions.invoke('member-portal', {
                    body: { action: 'update-power', payload: { uid: portalActiveUid, power: powerVal } }
                });
                if (error || !data || !data.ok) {
                    throw new Error(error ? error.message : 'Update failed');
                }
                showToast('Your combat power has been updated successfully!', 'success');
                // Sync local guildMembers if loaded
                var localMember = guildMembers.find(function (m) { return m.uid === portalActiveUid; });
                if (localMember) {
                    localMember.overall_power = powerVal;
                    renderGuildMembers();
                }
            } catch (err) {
                console.error(err);
                showToast('Failed to update combat power: ' + err.message, 'error');
            } finally {
                portalUpdatePowerBtn.disabled = false;
                portalUpdatePowerBtn.innerHTML = origText;
            }
        });
    }

    function renderPortalActiveSessions(uid, sessions) {
        var container = document.getElementById('portal-active-sessions-container');
        if (!sessions || sessions.length === 0) {
            container.innerHTML = '<div class="gm-empty" style="padding: 1.5rem 0;"><i class="ph ph-ghost gm-icon" style="font-size: 1.8rem;"></i><div class="gm-empty-title" style="font-size: 0.85rem;">No active events for your guild.</div></div>';
            return;
        }

        var html = '';
        sessions.forEach(function (sess, idx) {
            var eventName = sess.event_name;
            var isSvsOrGvg = eventName === 'SvS' || eventName === 'GvG';
            var isDtr = eventName === 'Defend Trade Route';
            var isShadowfront = eventName === 'Shadowfront';
            
            var EVENTS_WITHOUT_SCORE = ['Defend Trade Route', 'Shadowfront', 'ARMS RACE STAGE A', 'ARMS RACE STAGE B'];
            var hasScore = EVENTS_WITHOUT_SCORE.indexOf(eventName) === -1;

            var curr = sess.current_data || {};
            var isChecked = curr.participated > 0;
            var isLateChecked = !!curr.late;
            var isExcusedChecked = !!curr.excused;
            var isAppointedChecked = !!curr.appointed;

            var fieldsHtml = '';

            fieldsHtml += 
                '<div class="gm-login-field" style="margin-bottom:0.75rem;">' +
                    '<label style="display:flex; align-items:center; cursor:pointer; gap:0.6rem; user-select:none;">' +
                        '<div class="participation-check">' +
                            '<input type="checkbox" class="participation-checkbox portal-check-participated" ' + (isChecked ? 'checked' : '') + '>' +
                            '<span class="check-mark" style="width:20px; height:20px; font-size:0.8rem;"><i class="ph ph-check"></i></span>' +
                        '</div>' +
                        '<span style="font-size:0.88rem; color:var(--fg-dim); font-weight:500;">I participated in this event</span>' +
                    '</label>' +
                '</div>';

            if (isDtr) {
                fieldsHtml += 
                    '<div class="gm-login-field" style="margin-bottom:0.75rem;">' +
                        '<label style="display:flex; align-items:center; cursor:pointer; gap:0.6rem; user-select:none;">' +
                            '<div class="participation-check">' +
                                '<input type="checkbox" class="participation-checkbox portal-check-appointed" ' + (isAppointedChecked ? 'checked' : '') + '>' +
                                '<span class="check-mark" style="width:20px; height:20px; font-size:0.8rem;"><i class="ph ph-check"></i></span>' +
                            '</div>' +
                            '<span style="font-size:0.88rem; color:var(--fg-dim); font-weight:500;">Appointed</span>' +
                        '</label>' +
                    '</div>';
            }

            if (isShadowfront) {
                fieldsHtml += 
                    '<div class="gm-login-field" style="margin-bottom:0.75rem;">' +
                        '<label style="display:flex; align-items:center; cursor:pointer; gap:0.6rem; user-select:none;">' +
                            '<div class="participation-check">' +
                                '<input type="checkbox" class="participation-checkbox portal-check-late" ' + (isLateChecked ? 'checked' : '') + '>' +
                                '<span class="check-mark" style="width:20px; height:20px; font-size:0.8rem;"><i class="ph ph-check"></i></span>' +
                            '</div>' +
                            '<span style="font-size:0.88rem; color:var(--fg-dim); font-weight:500;">Late</span>' +
                        '</label>' +
                    '</div>' +
                    '<div class="gm-login-field" style="margin-bottom:0.75rem;">' +
                        '<label style="display:flex; align-items:center; cursor:pointer; gap:0.6rem; user-select:none;">' +
                            '<div class="participation-check">' +
                                '<input type="checkbox" class="participation-checkbox portal-check-excused" ' + (isExcusedChecked ? 'checked' : '') + '>' +
                                '<span class="check-mark" style="width:20px; height:20px; font-size:0.8rem;"><i class="ph ph-check"></i></span>' +
                            '</div>' +
                            '<span style="font-size:0.88rem; color:var(--fg-dim); font-weight:500;">Excused</span>' +
                        '</label>' +
                    '</div>';
            }

            if (hasScore) {
                if (isSvsOrGvg) {
                    fieldsHtml += 
                        '<div class="gm-login-field" style="margin-bottom:0.5rem;">' +
                            '<label style="font-size:0.75rem; color:var(--fg-dim); margin-bottom:0.2rem;">Day 1 to 5 score</label>' +
                            '<input type="text" class="gm-input gm-input-sm portal-score-prep" value="' + (curr.score_prep != null ? curr.score_prep : '') + '" placeholder="e.g. 150000">' +
                        '</div>' +
                        '<div class="gm-login-field" style="margin-bottom:0.5rem;">' +
                            '<label style="font-size:0.75rem; color:var(--fg-dim); margin-bottom:0.2rem;">Day 6 score</label>' +
                            '<input type="text" class="gm-input gm-input-sm portal-score-pvp" value="' + (curr.score_pvp != null ? curr.score_pvp : '') + '" placeholder="e.g. 50000">' +
                        '</div>';
                } else {
                    fieldsHtml += 
                        '<div class="gm-login-field" style="margin-bottom:0.5rem;">' +
                            '<label style="font-size:0.75rem; color:var(--fg-dim); margin-bottom:0.2rem;">Score</label>' +
                            '<input type="text" class="gm-input gm-input-sm portal-score" value="' + (curr.score != null ? curr.score : '') + '" placeholder="e.g. 45000">' +
                        '</div>';
                }
            }

            var statusBadge = curr.is_pending 
                ? '<span class="gm-chip" style="margin-left:auto; background:rgba(245,158,11,0.12); color:var(--warning); border:1px solid rgba(245,158,11,0.25);">Pending approval</span>'
                : '';

            html += 
                '<div class="portal-event-card" data-event="' + esc(eventName) + '" data-session="' + esc(sess.session_id) + '" style="background:var(--bg-1); border:1px solid var(--border-soft); border-radius:8px; padding:0.75rem 1rem;">' +
                    '<div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.75rem;">' +
                        '<strong style="font-size:0.9rem; color:var(--accent);">' + esc(eventName) + '</strong>' +
                        statusBadge +
                    '</div>' +
                    '<div class="gm-col" style="gap:0.4rem;">' +
                        fieldsHtml +
                    '</div>' +
                    '<button type="button" class="gm-btn gm-btn-primary gm-btn-sm portal-submit-event-btn" style="margin-top:0.75rem; width:100%; font-size:0.78rem; padding:0.35rem 0.5rem;">' +
                        '<i class="ph ph-paper-plane-right"></i>' +
                        '<span>Submit Scores</span>' +
                    '</button>' +
                '</div>';
        });

        container.innerHTML = html;

        container.querySelectorAll('.portal-score, .portal-score-prep, .portal-score-pvp').forEach(function (inp) {
            window.RAD.attachNumberFormatter(inp);
        });

        container.querySelectorAll('.portal-check-appointed').forEach(function (cb) {
            cb.addEventListener('change', function () {
                if (cb.checked) {
                    var card = cb.closest('.portal-event-card');
                    var partCb = card ? card.querySelector('.portal-check-participated') : null;
                    if (partCb) {
                        partCb.checked = true;
                    }
                }
            });
        });

        container.querySelectorAll('.portal-submit-event-btn').forEach(function (btn) {
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
                    uid: uid,
                    event_name: eventName,
                    session_id: sessionId,
                    participated: participated,
                    appointed: appointed,
                    late: late,
                    excused: excused,
                    score: scoreVal !== undefined ? window.RAD.parseNumber(scoreVal) : undefined,
                    score_prep: scorePrepVal !== undefined ? window.RAD.parseNumber(scorePrepVal) : undefined,
                    score_pvp: scorePvpVal !== undefined ? window.RAD.parseNumber(scorePvpVal) : undefined
                };

                btn.disabled = true;
                var span = btn.querySelector('span');
                var origText = span ? span.textContent : '';
                if (span) span.textContent = 'Submitting...';

                try {
                    var { data, error } = await supabase.functions.invoke('member-portal', {
                        body: { action: 'submit-scores', payload: payload }
                    });

                    if (error || !data || !data.ok) {
                        showToast('Submission failed. Check your parameters.', 'error');
                        return;
                    }

                    showToast('Scores submitted successfully! Pending officer approval.', 'success');
                    
                    var badge = card.querySelector('.gm-chip');
                    if (!badge) {
                        var header = card.querySelector('div');
                        header.insertAdjacentHTML('beforeend', '<span class="gm-chip" style="margin-left:auto; background:rgba(245,158,11,0.12); color:var(--warning); border:1px solid rgba(245,158,11,0.25);">Pending approval</span>');
                    }
                } catch (err) {
                    console.error(err);
                    showToast('An error occurred during submission.', 'error');
                } finally {
                    btn.disabled = false;
                    if (span) span.textContent = origText;
                }
            });
        });
    }

    window.RAD_APP = { showToast: showToast, reloadActiveView: reloadActiveView };

})();
