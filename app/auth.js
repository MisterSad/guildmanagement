/**
 * auth.js: R5 self-service email auth (saas_strategy.md §6.1).
 *
 * A SECOND auth path next to the existing identifier+password flow (kept for
 * R4 officers and pre-cutover R5s). Guild leaders sign up / log in with a real
 * email via Supabase native auth, and can reset their password by email.
 *
 * Gated by GMT_CONFIG.R5_EMAIL_AUTH: it needs the multi-tenant guilds table
 * (bootstrap-r5 edge function) and email delivery, so it stays OFF on the
 * current single-tenant production — the signup / forgot links don't render and
 * email login is never attempted. Flip the flag on with the cutover.
 *
 * Public API:
 *   isEmailLogin(s)      true when the flag is on and s looks like an email
 *   emailLogin(email,p)  Supabase sign-in (+ first-time guild bootstrap),
 *                        returns { ok, role, id } like RAD.login
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };

    function enabled() { return !!(window.GMT_CONFIG && window.GMT_CONFIG.R5_EMAIL_AUTH); }
    function looksEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }
    function appUrl() { return window.location.origin + '/app/'; }

    window.RAD_AUTH = {
        isEmailLogin: function (s) { return enabled() && looksEmail(s); },
        emailLogin: emailLogin
    };

    // ── Login ────────────────────────────────────────────────────────────────
    async function emailLogin(email, password) {
        if (!db) return { ok: false };
        var r;
        try { r = await db.auth.signInWithPassword({ email: email.trim(), password: password }); }
        catch (_) { return { ok: false }; }
        if (r.error || !r.data || !r.data.session) return { ok: false };
        var info = await ensureGuild();
        return { ok: true, role: info.role, id: info.displayName };
    }

    // A freshly-confirmed R5 has no guild yet (empty app_metadata). Create it
    // once via bootstrap-r5, then refresh the session to pick up the new claims.
    async function ensureGuild() {
        var info = await window.RAD.sessionInfo();
        if (info && info.guildId) return { role: info.role, displayName: info.accountId || '' };
        try {
            await db.functions.invoke('bootstrap-r5', { body: {} });
            await db.auth.refreshSession();
        } catch (_) { /* surfaced on next load if it failed */ }
        var after = await window.RAD.sessionInfo();
        return { role: (after && after.role) || 'R5', displayName: (after && after.accountId) || '' };
    }

    // ── Login-view extras (signup / forgot links) ────────────────────────────
    function mountLinks() {
        var slot = document.querySelector('[data-gmt-auth-extra]');
        if (!slot || !enabled()) return;
        slot.innerHTML =
            '<div class="gm-auth-links" style="display:flex; justify-content:space-between; gap:.5rem; margin-top:.85rem; font-size:.82rem;">' +
                '<a href="#" data-auth-signup class="gm-link">' + esc(t('auth_signup_link')) + '</a>' +
                '<a href="#" data-auth-forgot class="gm-link">' + esc(t('auth_forgot_link')) + '</a>' +
            '</div>';
        slot.querySelector('[data-auth-signup]').addEventListener('click', function (e) { e.preventDefault(); openSignup(); });
        slot.querySelector('[data-auth-forgot]').addEventListener('click', function (e) { e.preventDefault(); openForgot(); });
    }

    function overlay(innerHtml) {
        var prev = document.getElementById('auth-overlay');
        if (prev) prev.remove();
        var o = document.createElement('div');
        o.id = 'auth-overlay';
        o.className = 'confirm-overlay';
        o.innerHTML = '<div class="confirm-card glass-card" style="max-width:440px;">' + innerHtml + '</div>';
        document.body.appendChild(o);
        requestAnimationFrame(function () { o.classList.add('visible'); });
        o.addEventListener('click', function (ev) { if (ev.target === o) close(o); });
        return o;
    }
    function close(o) { o.classList.remove('visible'); setTimeout(function () { o.remove(); }, 300); }

    // ── Signup ────────────────────────────────────────────────────────────────
    function openSignup() {
        var o = overlay(
            '<div class="confirm-icon"><i class="ph-fill ph-shield-plus text-accent"></i></div>' +
            '<h3>' + esc(t('auth_signup_title')) + '</h3>' +
            '<form id="auth-signup-form" class="gm-col" style="gap:.85rem; text-align:left; margin-top:1rem;">' +
                field('su-guild', t('auth_signup_guild'), 'text', 'ph-flag-banner') +
                field('su-email', t('auth_signup_email'), 'email', 'ph-envelope') +
                field('su-pass', t('auth_signup_pass'), 'password', 'ph-lock') +
                '<div class="confirm-actions"><button type="button" class="btn-ghost" data-cancel>' + t('confirm_cancel') + '</button>' +
                '<button type="submit" class="primary-btn">' + t('auth_signup_submit') + '</button></div>' +
            '</form>');
        o.querySelector('[data-cancel]').addEventListener('click', function () { close(o); });
        o.querySelector('#auth-signup-form').addEventListener('submit', async function (e) {
            e.preventDefault();
            var name = o.querySelector('#su-guild').value.trim();
            var email = o.querySelector('#su-email').value.trim();
            var pass = o.querySelector('#su-pass').value;
            if (!name || !looksEmail(email) || pass.length < 8) { window.RAD.showToast(t('auth_err_signup_fields'), 'error'); return; }
            try {
                var r = await db.auth.signUp({ email: email, password: pass, options: { data: { guild_name: name }, emailRedirectTo: appUrl() } });
                if (r.error) throw r.error;
                if (r.data && r.data.session) {
                    await ensureGuild();
                    close(o);
                    window.location.reload();
                } else {
                    close(o);
                    window.RAD.showToast(t('auth_signup_check_email'), 'success');
                }
            } catch (err) {
                window.RAD.showToast((err && err.message) || t('auth_err_generic'), 'error');
            }
        });
    }

    // ── Forgot password ──────────────────────────────────────────────────────
    function openForgot() {
        var o = overlay(
            '<div class="confirm-icon"><i class="ph-fill ph-key text-accent"></i></div>' +
            '<h3>' + esc(t('auth_forgot_title')) + '</h3>' +
            '<p>' + esc(t('auth_forgot_body')) + '</p>' +
            '<form id="auth-forgot-form" class="gm-col" style="gap:.85rem; text-align:left; margin-top:1rem;">' +
                field('fp-email', t('auth_signup_email'), 'email', 'ph-envelope') +
                '<div class="confirm-actions"><button type="button" class="btn-ghost" data-cancel>' + t('confirm_cancel') + '</button>' +
                '<button type="submit" class="primary-btn">' + t('auth_forgot_submit') + '</button></div>' +
            '</form>');
        o.querySelector('[data-cancel]').addEventListener('click', function () { close(o); });
        o.querySelector('#auth-forgot-form').addEventListener('submit', async function (e) {
            e.preventDefault();
            var email = o.querySelector('#fp-email').value.trim();
            if (!looksEmail(email)) { window.RAD.showToast(t('auth_err_signup_fields'), 'error'); return; }
            try {
                var r = await db.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
                if (r.error) throw r.error;
            } catch (_) { /* do not reveal whether the email exists */ }
            close(o);
            window.RAD.showToast(t('auth_forgot_sent'), 'success'); // always, to avoid account enumeration
        });
    }

    // ── Password recovery (arriving from the reset email link) ───────────────
    function openReset() {
        var o = overlay(
            '<div class="confirm-icon"><i class="ph-fill ph-lock-key text-accent"></i></div>' +
            '<h3>' + esc(t('auth_reset_title')) + '</h3>' +
            '<p>' + esc(t('auth_reset_body')) + '</p>' +
            '<form id="auth-reset-form" class="gm-col" style="gap:.85rem; text-align:left; margin-top:1rem;">' +
                field('rp-pass', t('auth_signup_pass'), 'password', 'ph-lock') +
                '<div class="confirm-actions"><button type="submit" class="primary-btn">' + t('auth_reset_submit') + '</button></div>' +
            '</form>');
        o.querySelector('#auth-reset-form').addEventListener('submit', async function (e) {
            e.preventDefault();
            var pass = o.querySelector('#rp-pass').value;
            if (pass.length < 8) { window.RAD.showToast(t('auth_err_signup_fields'), 'error'); return; }
            try {
                var r = await db.auth.updateUser({ password: pass });
                if (r.error) throw r.error;
                close(o);
                window.RAD.showToast(t('auth_reset_done'), 'success');
            } catch (err) {
                window.RAD.showToast((err && err.message) || t('auth_err_generic'), 'error');
            }
        });
    }

    function field(id, label, type, icon) {
        return '<div class="gm-col" style="gap:.3rem;"><label class="gm-dim" style="font-size:.82rem;" for="' + id + '">' + esc(label) + '</label>' +
            '<div class="gm-input-with-icon"><i class="ph ' + icon + ' gm-icon"></i>' +
            '<input type="' + type + '" id="' + id + '" class="gm-input" required></div></div>';
    }

    // ── Boot ──────────────────────────────────────────────────────────────────
    if (enabled() && db) {
        db.auth.onAuthStateChange(function (event) {
            if (event === 'PASSWORD_RECOVERY') openReset();
        });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountLinks);
        else mountLinks();
        document.addEventListener('gmt:langchange', mountLinks);
    }

})();
