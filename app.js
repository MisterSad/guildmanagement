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

    // ─── State ────────────────────────────────────────────────────────────────
    var accounts     = [];
    var guildMembers = [];

    // ─── Language Switcher ────────────────────────────────────────────────────
    document.querySelectorAll('.lang-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            window.RAD_I18N.setLang(btn.getAttribute('data-lang'));
        });
    });

    // ─── Boot ─────────────────────────────────────────────────────────────────
    window.RAD_I18N.applyTranslations();
    document.querySelectorAll('.lang-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === window.RAD_I18N.getLang());
    });

    // Restaure depuis la session Supabase persistée (survit au rechargement
    // et à la fermeture d'onglet tant que le refresh token est valide).
    (async function restoreSession() {
        var info = await window.RAD.sessionInfo();
        if (!info) return;
        var role = info.role === 'R5' ? 'admin' : 'member';
        sessionStorage.setItem('rad_role', role);
        if (info.accountId) sessionStorage.setItem('rad_user', info.accountId);
        showAdminDashboard(role);
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

                var role = (resp.role === 'R5') ? 'admin' : 'member';
                sessionStorage.setItem('rad_role', role);
                sessionStorage.setItem('rad_user', user);

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
        sessionStorage.removeItem('rad_role');
        sessionStorage.removeItem('rad_user');
        showLogin();
        showToast(t('toast_logout'), 'info');
    }

    // ─── View Switching ───────────────────────────────────────────────────────
    function showAdminDashboard(role) {
        role = role || sessionStorage.getItem('rad_role');
        loginView.classList.add('hidden');
        if (memberView) memberView.classList.add('hidden');
        dashboardView.classList.remove('hidden');
        dashboardView.classList.add('active');

        var adminHomeBtn = document.querySelector('.nav-tab[data-tab="admin-home"]');
        var roleLabel = document.getElementById('nav-user-role');
        var nameLabel = document.getElementById('nav-user-name');

        if (role === 'member') {
            if (roleLabel) roleLabel.textContent = 'R4 :';
            if (nameLabel) nameLabel.textContent = sessionStorage.getItem('rad_user') || 'Officier';
            if (adminHomeBtn) adminHomeBtn.style.display = 'none';
        } else {
            if (roleLabel) roleLabel.textContent = 'R5 :';
            if (nameLabel) nameLabel.textContent = sessionStorage.getItem('rad_user') || 'Admin';
            if (adminHomeBtn) adminHomeBtn.style.display = '';
            fetchAccounts();
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
            var eventName = tabBtn.getAttribute('data-event-tab');
            if (eventName && ['SvS', 'GvG', 'Defend Trade Route', 'ARMS RACE'].indexOf(eventName) !== -1 && window.RAD_EVENTS) {
                window.RAD_EVENTS.loadEvent(eventName);
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
                var res = await window.RAD.adminAccounts('create', { id: identifier, password: newPassword, role: 'R4' });
                if (!res.ok) throw new Error(res.error || 'create_failed');
                accounts.unshift({ id: identifier, password: newPassword, role: 'R4', created_at: new Date().toISOString() });
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
            var chipCls = role === 'R5' ? 'gm-chip-accent' : 'gm-chip-info';
            var dateStr = acc.created_at ? new Date(acc.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' }) : '—';
            html +=
                '<div class="gm-cred-card" data-acc-id="' + esc(acc.id) + '">' +
                    '<div class="gm-row" style="justify-content:space-between;">' +
                        '<div class="gm-cred-name">' + esc(acc.id) + '</div>' +
                        '<span class="gm-chip ' + chipCls + '">' + esc(role) + '</span>' +
                    '</div>' +
                    '<div class="gm-cred-pass gm-masked" data-acc-pass="' + esc(acc.password) + '">' +
                        '<span class="gm-pwd-text">••••••••••••</span>' +
                        '<button class="gm-mini-btn gm-cred-toggle" title="' + t('show_pwd') + '"><i class="ph ph-eye"></i></button>' +
                        '<button class="gm-mini-btn gm-cred-copy" title="' + t('copy_title') + '"><i class="ph ph-copy"></i></button>' +
                    '</div>' +
                    '<div class="gm-row gm-dim" style="font-size:.75rem;">' +
                        '<i class="ph ph-calendar-blank"></i>' +
                        '<span>' + t('cred_created') + ' ' + dateStr + '</span>' +
                        '<button class="gm-mini-btn gm-danger gm-cred-delete" data-id="' + esc(acc.id) + '" title="' + t('delete_title') + '" style="margin-left:auto;">' +
                            '<i class="ph ph-trash"></i>' +
                        '</button>' +
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
            var res = await supabase.from('guild_members').insert([{ pseudo: pseudo, uid: uidVal }]);
            if (res.error) throw res.error;
            guildMembers.push({ pseudo: pseudo, uid: uidVal, created_at: new Date().toISOString() });
            if (input) input.value = '';
            if (uidInput) uidInput.value = '';
            renderGuildMembers();
            showToast(pseudo + ' ' + t('toast_member_added'), 'success');

            if (window.RAD_EVENTS && window.RAD_EVENTS.addMemberToActiveEvents) {
                window.RAD_EVENTS.addMemberToActiveEvents(pseudo).then(function (n) {
                    if (n > 0) showToast(pseudo + ' ' + t('toast_member_added_active_events'), 'info');
                });
            }
        } catch (err) {
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
    }

    if (addMemberForm)  addMemberForm.addEventListener('submit', function (e)  { e.preventDefault(); handleAddMember('member-pseudo', 'member-uid'); });
    if (addMemberFormM) addMemberFormM.addEventListener('submit', function (e) { e.preventDefault(); handleAddMember('member-pseudo-m', 'member-uid-m'); });

    var searchAdmin = document.getElementById('member-search-admin');
    if (searchAdmin) searchAdmin.addEventListener('input', renderGuildMembers);
    var searchMember = document.getElementById('member-search-member');
    if (searchMember) searchMember.addEventListener('input', renderGuildMembers);

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
        var uidVal = m.uid || '—';
        var dateStr = m.created_at
            ? new Date(m.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' })
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

    window.RAD_APP = { showToast: showToast };

})();
