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

        await fetchGuilds();

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
                } else {
                    window.currentGuildRestriction = null;
                }
            } catch (err) {
                console.error('Failed to restore account guild restriction:', err);
                window.currentGuildRestriction = null;
            }
        } else {
            window.currentGuildRestriction = null;
        }

        var role = info.role === 'R5' ? 'admin' : 'member';
        localStorage.setItem('rad_role', role);
        if (info.accountId) {
            localStorage.setItem('rad_user', info.accountId);
        }

        // Si le rôle/user a changé ou si le dashboard n'était pas affiché
        if (!localRole || localRole !== role || localUser !== info.accountId) {
            showAdminDashboard(role);
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
                        } else {
                            window.currentGuildRestriction = null;
                        }
                    } catch (err) {
                        console.error('Failed to load login guild restriction:', err);
                        window.currentGuildRestriction = null;
                    }
                } else {
                    window.currentGuildRestriction = null;
                }

                var role = (resp.role === 'R5') ? 'admin' : 'member';
                localStorage.setItem('rad_role', role);
                localStorage.setItem('rad_user', user);

                showAdminDashboard(role);
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

        if (createAccountCard) createAccountCard.style.display = '';
        if (activeAccountsCard) activeAccountsCard.style.display = '';
        if (isR5) {
            if (createGuildCard) createGuildCard.style.display = '';
        } else {
            if (createGuildCard) createGuildCard.style.display = 'none';
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
            var { data, error } = await supabase.from('guilds').select('id').order('id');
            if (error) throw error;
            if (data && data.length > 0) {
                window.guildsList = data.map(function (g) { return g.id; });
                
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
            if (span) span.textContent = 'Création...';

            try {
                var { error } = await supabase.from('guilds').insert({ id: guildName });
                if (error) throw error;
                
                showToast('Guilde ' + guildName + ' créée avec succès !', 'success');
                input.value = '';
                await fetchGuilds();
            } catch (err) {
                showToast('Erreur lors de la création de la guilde: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                if (span) span.textContent = origText;
            }
        });
    }

    async function loadGuildSettings() {
        var form = document.getElementById('guild-settings-form');
        if (!form) return;

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
                await Promise.all([
                    window.RAD.config.set('coeff_svs', document.getElementById('coeff-svs').value),
                    window.RAD.config.set('coeff_gvg', document.getElementById('coeff-gvg').value),
                    window.RAD.config.set('coeff_shadowfront', document.getElementById('coeff-shadowfront').value),
                    window.RAD.config.set('coeff_dtr', document.getElementById('coeff-dtr').value),
                    window.RAD.config.set('coeff_armsrace', document.getElementById('coeff-armsrace').value),

                    window.RAD.config.set('webhook_armsrace', document.getElementById('webhook-armsrace').value.trim()),
                    window.RAD.config.set('webhook_dtr', document.getElementById('webhook-dtr').value.trim()),
                    window.RAD.config.set('webhook_shadowfront', document.getElementById('webhook-shadowfront').value.trim()),
                    window.RAD.config.set('webhook_calamity', document.getElementById('webhook-calamity').value.trim()),
                    window.RAD.config.set('webhook_gvg', document.getElementById('webhook-gvg').value.trim()),
                    window.RAD.config.set('webhook_svs', document.getElementById('webhook-svs').value.trim()),

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

                    window.RAD.config.set('notify_calamity_10', document.getElementById('notify-calamity-10').checked ? 'true' : 'false'),
                    window.RAD.config.set('notify_gvg_pvp', document.getElementById('notify-gvg-pvp').checked ? 'true' : 'false'),

                    window.RAD.config.set('notify_svs_garrison', document.getElementById('notify-svs-garrison').checked ? 'true' : 'false'),
                    window.RAD.config.set('notify_svs_pvp', document.getElementById('notify-svs-pvp').checked ? 'true' : 'false'),
                    window.RAD.config.set('notify_svs_won_prep', document.getElementById('notify-svs-won-prep').checked ? 'true' : 'false')
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
        // Cred-grid layout (auto-fill 280px min)
        var html = '<div class="gm-cred-grid">';
        accounts.forEach(function (acc) {
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
                    showToast('Accès de ' + id + ' mis à jour avec succès !', 'success');
                    
                    var acc = accounts.find(function (a) { return a.id === id; });
                    if (acc) {
                        acc.guild = (newGuild === 'ALL' ? null : newGuild);
                    }
                } catch (err) {
                    showToast('Erreur lors de la mise à jour : ' + err.message, 'error');
                    fetchAccounts();
                } finally {
                    sel.disabled = false;
                }
            });
        });
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

    async function handleAddMember(inputId, uidInputId) {
        var input  = document.getElementById(inputId);
        var pseudo = input ? input.value.trim() : '';
        var uidInput = document.getElementById(uidInputId);
        var uidVal = uidInput ? uidInput.value.trim() : null;
        if (!pseudo || !uidVal) return;

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
            var res = await supabase.from('guild_members').insert([{ pseudo: pseudo, uid: uidVal }]);
            if (res.error) throw res.error;
            guildMembers.push({ pseudo: pseudo, uid: uidVal, created_at: new Date().toISOString() });
            if (input) input.value = '';
            if (uidInput) uidInput.value = '';
            renderGuildMembers();
            showToast(pseudo + ' ' + t('toast_member_added'), 'success');

            var addedEvents = 0;
            if (window.RAD_EVENTS && window.RAD_EVENTS.addMemberToActiveEvents) {
                addedEvents += await window.RAD_EVENTS.addMemberToActiveEvents(pseudo);
            }
            if (window.RAD_ARMSRACE && window.RAD_ARMSRACE.addMemberToActiveEvents) {
                addedEvents += await window.RAD_ARMSRACE.addMemberToActiveEvents(pseudo);
            }
            if (addedEvents > 0) {
                showToast(pseudo + ' ' + t('toast_member_added_active_events'), 'info');
            }
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    if (addMemberForm)  addMemberForm.addEventListener('submit', function (e)  { e.preventDefault(); handleAddMember('member-pseudo', 'member-uid'); });
    if (addMemberFormM) addMemberFormM.addEventListener('submit', function (e) { e.preventDefault(); handleAddMember('member-pseudo-m', 'member-uid-m'); });
    if (addBannedForm) {
        addBannedForm.addEventListener('submit', function (e) { e.preventDefault(); handleAddBannedPlayer(); });
    }

    var searchAdmin = document.getElementById('member-search-admin');
    if (searchAdmin) searchAdmin.addEventListener('input', renderGuildMembers);
    var searchMember = document.getElementById('member-search-member');
    if (searchMember) searchMember.addEventListener('input', renderGuildMembers);
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
            showToast(pseudo + ' ' + t('toast_member_removed'), 'success');
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

    async function renameGuildMember(oldPseudo, newPseudo, newUid) {
        newPseudo = (newPseudo || '').trim();
        newUid    = (newUid || '').trim();

        var pseudoErr = window.RAD.validatePseudo(newPseudo);
        if (pseudoErr) { showToast(t(pseudoErr), 'error'); return false; }
        var uidErr = window.RAD.validateUid(newUid);
        if (uidErr) { showToast(t(uidErr), 'error'); return false; }

        var pseudoChanged = newPseudo.toLowerCase() !== oldPseudo.toLowerCase();
        var uidChanged    = (function () {
            var current = guildMembers.find(function (m) { return m.pseudo === oldPseudo; });
            return current && (current.uid || '') !== newUid;
        })();

        if (!pseudoChanged && !uidChanged) return true;

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
            // ON UPDATE CASCADE propagera le nouveau pseudo dans toutes les FK
            var update = {};
            if (pseudoChanged) update.pseudo = newPseudo;
            if (uidChanged)    update.uid = newUid || null;

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

        var filteredAdmin = guildMembers.filter(function (m) {
            return (m.pseudo.toLowerCase() + ' ' + (m.uid || '').toLowerCase()).indexOf(qAdmin) !== -1;
        });
        var filteredMember = guildMembers.filter(function (m) {
            return (m.pseudo.toLowerCase() + ' ' + (m.uid || '').toLowerCase()).indexOf(qMember) !== -1;
        });

        if (guildMemberCount)  guildMemberCount.textContent  = filteredAdmin.length;
        if (guildMemberCountM) guildMemberCountM.textContent = filteredMember.length;

        if (guildMemberList) {
            guildMemberList.innerHTML = filteredAdmin.length
                ? '<div class="gm-member-list">' + filteredAdmin.map(function (m, i) { return memberTileHtml(m, i, true); }).join('') + '</div>'
                : '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
        }
        if (guildMemberListM) {
            guildMemberListM.innerHTML = filteredMember.length
                ? '<div class="gm-member-list">' + filteredMember.map(function (m, i) { return memberTileHtml(m, i, false); }).join('') + '</div>'
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

    function memberTileHtml(m, i, withActions) {
        var lang = (window.RAD_I18N && window.RAD_I18N.getLang) ? window.RAD_I18N.getLang() : 'en';
        var locale = lang === 'fr' ? 'fr-FR' : 'en-GB';
        var uidVal = m.uid || '—';
        var dateStr = m.created_at
            ? new Date(m.created_at).toLocaleDateString(locale, { day:'2-digit', month:'2-digit', year:'numeric' })
            : '—';
        var initial = window.RAD.avatarInit(m.pseudo);
        return '<div class="gm-member-row" data-pseudo="' + esc(m.pseudo) + '">' +
                '<div class="gm-member-id">' +
                    '<div class="gm-avatar">' + esc(initial) + '</div>' +
                    '<div class="gm-grow gm-truncate">' +
                        '<div class="gm-member-pseudo gm-truncate">' + esc(m.pseudo) + '</div>' +
                        '<div class="gm-row" style="gap:.5rem; margin-top:2px;">' +
                            '<span class="gm-dim gm-mono" style="font-size:.78rem;">UID ' + esc(uidVal) + '</span>' +
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

    // ─── Edit Member Dialog ───────────────────────────────────────────────────
    function showEditMemberDialog(member) {
        var existing = document.getElementById('edit-member-overlay');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'edit-member-overlay';
        overlay.className = 'confirm-overlay';
        overlay.innerHTML =
            '<div class="confirm-card glass-card" style="max-width: 480px;">' +
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

        document.getElementById('edit-member-form').addEventListener('submit', async function (e) {
            e.preventDefault();
            var newPseudo = document.getElementById('edit-pseudo').value;
            var newUid    = document.getElementById('edit-uid').value;
            var ok = await renameGuildMember(member.pseudo, newPseudo, newUid);
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

    window.RAD_APP = { showToast: showToast, reloadActiveView: reloadActiveView };

})();
