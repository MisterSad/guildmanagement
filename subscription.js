/**
 * subscription.js — Voluntary donations ("Buy Me a Coffee").
 * The app is 100% free for all guilds since v127.0.
 * Donations help cover infrastructure (Vercel + Supabase) and paid AI OCR scan costs.
 * Accessible to guild admins and super admins in the Command Center.
 * Loaded on demand by app.js via window.GM_SUBSCRIPTION.load().
 */
(function () {

    var esc = (window.GM && window.GM.escapeHTML) || function (s) { return s; };
    var t = function (k) { return window.GM_I18N ? window.GM_I18N.t(k) : k; };

    var DONATION_TIERS = [
        { key: 'donation_2',  label: 'Buy a Coffee',  price: '2',  cents: 200,  tag: null, icon: 'ph-coffee' },
        { key: 'donation_5',  label: 'Buy 2 Coffees', price: '5',  cents: 500,  tag: 'Popular', icon: 'ph-coffee' },
        { key: 'donation_10', label: 'Buy a Lunch',   price: '10', cents: 1000, tag: null, icon: 'ph-heart' }
    ];

    var state = {
        config: null,       // { mode, configured }
        busy: false
    };

    function getDb() {
        return (window.GM && window.GM.db) ? window.GM.db : null;
    }

    function getGuildId() {
        return (window.GM && window.GM.getActiveGuild) ? window.GM.getActiveGuild() : 'ALPHA';
    }

    function isAdminRole() {
        var role = (window.GM && window.GM.roleFromStorage) ? window.GM.roleFromStorage() : null;
        return role === 'super_admin' || role === 'guild_admin';
    }

    function showToast(msg, type) {
        if (window.GM && window.GM.showToast) window.GM.showToast(msg, type);
    }

    // ── Redirect helper (stubbable for tests) ─────────────────────────────────
    function redirectTo(url) {
        window.location.assign(url);
    }

    function startCheckoutRedirect(url) {
        if (window.GM_SUBSCRIPTION && window.GM_SUBSCRIPTION._redirectTo) {
            window.GM_SUBSCRIPTION._redirectTo(url);
        } else {
            redirectTo(url);
        }
    }

    // ── Load & Bootstrap ──────────────────────────────────────────────────────
    async function load() {
        var container = document.getElementById('subscription-container');
        if (!container) return;

        if (!isAdminRole()) {
            container.innerHTML = deniedHtml();
            return;
        }

        var guildId = getGuildId();
        if (!window.guildsData || !window.guildsData[guildId]) {
            try {
                await refreshGuildsData();
            } catch (err) { /* ignore */ }
        }

        if (window.GM && window.GM.isPaymentsDisabled && window.GM.isPaymentsDisabled(guildId)) {
            container.innerHTML = paymentsDisabledHtml();
            return;
        }

        state.config = null;
        container.innerHTML = loadingHtml();

        try {
            var db = getDb();
            if (!db || !db.functions) throw new Error('no_db');
            var res = await db.functions.invoke('gm-create-order', { body: { action: 'config' } });
            var data = res.data || {};
            if (!data.ok) throw new Error(data.error || 'config_failed');
            state.config = data;
            render(container);
            await handleReturn(container);
        } catch (err) {
            container.innerHTML = errorHtml((err && err.message) || 'load_failed');
            wireRetry(container);
        }
    }

    function wireRetry(container) {
        var btn = document.getElementById('subscription-retry');
        if (btn) btn.addEventListener('click', load);
    }

    // ── Free App Status Banner ───────────────────────────────────────────────
    function freeAppStatusCardHtml() {
        return '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1.25rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap;">' +
            '<div style="width:48px; height:48px; border-radius:12px; background:var(--accent-soft, rgba(99,102,241,0.15)); color:var(--accent, #6366f1); display:flex; align-items:center; justify-content:center; font-size:1.5rem; flex-shrink:0;">' +
                '<i class="ph-fill ph-coffee"></i>' +
            '</div>' +
            '<div style="flex:1; min-width:200px;">' +
                '<div style="font-weight:700; font-size:1.05rem; color:var(--fg);">' + (t('gm_nav_donate') || 'Buy Me a Coffee') + '</div>' +
                '<div class="gm-dim" style="font-size:.85rem; margin-top:0.2rem;">' + (t('gm_donate_subtitle') || 'The app is free. If it makes your guild stronger, you can support its development with a voluntary donation.') + '</div>' +
            '</div>' +
            '<div style="display:flex; gap:.5rem; align-items:center;">' +
                '<span class="gm-chip" style="background:var(--accent-soft, rgba(99,102,241,0.15)); color:var(--accent, #6366f1); font-weight:700; font-size:.75rem; letter-spacing:.03em;">100% FREE</span>' +
            '</div>' +
        '</div>';
    }

    // ── Tier Cards ────────────────────────────────────────────────────────────
    function tierCardHtml(tier) {
        var featured = tier.tag ? ' gm-sub-plan-featured' : '';
        return '<div class="gm-sub-plan-card' + featured + '">' +
            (tier.tag ? '<span class="gm-sub-plan-tag">' + esc(tier.tag) + '</span>' : '') +
            '<div class="gm-sub-plan-label">' + esc(tier.label) + '</div>' +
            '<div class="gm-sub-plan-price">€' + esc(tier.price) + '</div>' +
            '<div class="gm-sub-plan-period">' + (t('gm_sub_one_time') || 'voluntary one-time donation') + '</div>' +
            '<button class="gm-btn gm-btn-primary gm-sub-buy" data-gm-sub-plan="' + tier.key + '">' +
                '<i class="ph ' + tier.icon + '"></i> ' + (t('gm_sub_subscribe') || 'Donate') + ' €' + esc(tier.price) +
            '</button>' +
        '</div>';
    }

    // ── Transparency Section Card ─────────────────────────────────────────────
    function transparencyCardHtml() {
        return '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1.25rem;">' +
            '<div style="font-size:.95rem; font-weight:700; color:var(--fg); margin-bottom:.75rem; display:flex; align-items:center; gap:0.5rem;">' +
                '<i class="ph ph-heart" style="color:var(--accent, #6366f1);"></i> ' +
                '<span>Why your support matters</span>' +
            '</div>' +
            '<div style="font-size:.875rem; line-height:1.6; color:var(--fg-dim);">' +
                '<p style="margin:0 0 .75rem 0;">This app is free, and it stays free. But it is not free to run:</p>' +
                '<ul style="margin:0 0 .75rem 1.25rem; padding:0; display:flex; flex-direction:column; gap:0.4rem;">' +
                    '<li><strong>Hosting &amp; infrastructure (Vercel + Supabase):</strong> roughly EUR 45-100 every month, rain or shine.</li>' +
                    '<li><strong>AI OCR scans:</strong> every screenshot you analyze calls a paid AI API. Costs scale directly with how much the community uses it.</li>' +
                    '<li><strong>Development:</strong> hundreds of hours of design, coding, bug fixes, and feature requests handled one by one — evenings and weekends, on top of a day job.</li>' +
                '</ul>' +
                '<p style="margin:0;">Your donation covers the servers, keeps the AI scans flowing, and tells me the time I put into this tool is worth it. Every coffee genuinely helps. Thank you!</p>' +
            '</div>' +
        '</div>';
    }

    // ── Custom Amount Card ────────────────────────────────────────────────────
    function customAmountCardHtml() {
        return '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1.25rem;">' +
            '<div style="font-size:.95rem; font-weight:700; color:var(--fg); margin-bottom:.5rem;">' +
                (t('gm_donate_custom') || 'Custom amount') +
            '</div>' +
            '<div class="gm-dim" style="font-size:.82rem; margin-bottom:.75rem;">' +
                'Enter any voluntary donation amount between €2 and €100.' +
            '</div>' +
            '<div style="display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap; max-width:460px;">' +
                '<div style="position:relative; flex:1; min-width:140px;">' +
                    '<span style="position:absolute; left:0.75rem; top:50%; transform:translateY(-50%); font-weight:700; color:var(--fg-dim);">€</span>' +
                    '<input type="number" id="donation-custom-input" class="gm-input" min="2" max="100" step="1" placeholder="25" style="padding-left:1.75rem; width:100%; box-sizing:border-box;">' +
                '</div>' +
                '<button class="gm-btn gm-btn-primary" id="donation-custom-btn" style="white-space:nowrap;">' +
                    '<i class="ph ph-coffee"></i> ' + (t('gm_sub_subscribe') || 'Donate') +
                '</button>' +
            '</div>' +
            '<div id="donation-custom-error" class="gm-dim" style="color:#ef4444; font-size:.8rem; margin-top:.5rem; display:none;">' +
                (t('gm_donate_invalid_amount') || 'Please enter a valid amount between 2 and 100 EUR.') +
            '</div>' +
        '</div>';
    }

    // ── Start Checkout Flow via member-portal:create-donation ─────────────────
    async function startCheckout(planKey, customAmountCents, triggerBtn) {
        var cfg = state.config;
        if (!cfg || !cfg.configured) {
            showToast(t('gm_donate_not_configured') || t('gm_sub_not_configured') || 'Donations are not configured yet.', 'error');
            return;
        }
        if (state.busy) return;
        state.busy = true;

        var origHtml = '';
        if (triggerBtn) {
            origHtml = triggerBtn.innerHTML;
            triggerBtn.disabled = true;
            triggerBtn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> <span>Redirecting...</span>';
        }

        var guildId = getGuildId();
        var db = getDb();
        var returnUrl = window.location.href.split('?')[0];

        try {
            var bodyPayload = {
                plan: planKey,
                guildId: guildId,
                returnUrl: returnUrl
            };
            if (planKey === 'donation_custom') {
                bodyPayload.amountCents = customAmountCents;
            }

            var res = await db.functions.invoke('member-portal', {
                body: { action: 'create-donation', payload: bodyPayload }
            });
            var data = res.data || {};
            if (!data.ok || !data.url) throw new Error(data.error || 'order_failed');

            startCheckoutRedirect(data.url);
        } catch (err) {
            state.busy = false;
            if (triggerBtn) {
                triggerBtn.disabled = false;
                triggerBtn.innerHTML = origHtml;
            }
            var errCode = (err && err.message) || '';
            if (errCode === 'donations_disabled') {
                showToast(t('gm_donate_disabled_body') || 'Donations are disabled on this guild.', 'info');
            } else if (errCode === 'invalid_amount') {
                showToast(t('gm_donate_invalid_amount') || 'Please enter a valid amount between 2 and 100 EUR.', 'error');
            } else {
                showToast(t('gm_sub_widget_error') || 'Could not start the donation checkout.', 'error');
            }
        }
    }

    // ── Refresh local cache ───────────────────────────────────────────────────
    async function refreshGuildsData() {
        var db = getDb();
        if (!db) return;
        try {
            var res = await db.from('guilds')
                .select('id, subscription_type, subscription_end, server_number, payments_disabled')
                .order('id');
            if (res.error || !res.data || res.data.length === 0) return;
            window.guildsList = res.data.map(function (g) { return g.id; });
            window.guildsData = {};
            res.data.forEach(function (g) {
                var sNum = g.server_number || localStorage.getItem('gm_server_number_' + g.id) || '';
                window.guildsData[g.id] = {
                    type: g.subscription_type || 'Unlimited',
                    end: g.subscription_end || null,
                    server_number: sNum,
                    paymentsDisabled: !!g.payments_disabled
                };
            });
            if (window.GM_SHELL) {
                if (window.GM_SHELL.renderSidebar) window.GM_SHELL.renderSidebar();
                if (window.GM_SHELL.renderTopbar) window.GM_SHELL.renderTopbar();
            }
        } catch (err) { /* non fatal */ }
    }

    // ── Main Render ───────────────────────────────────────────────────────────
    function render(container) {
        var html = freeAppStatusCardHtml();

        // 1. Tiers grid
        html +=
            '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1.25rem;">' +
                '<div class="gm-dim" style="font-size:.75rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; margin-bottom:.75rem;">' +
                    (t('gm_sub_plans_title') || 'Support the Project') +
                '</div>' +
                '<div class="gm-sub-plans-grid">' +
                    DONATION_TIERS.map(tierCardHtml).join('') +
                '</div>' +
            '</div>';

        // 2. Custom amount card
        html += customAmountCardHtml();

        // 3. Transparency card
        html += transparencyCardHtml();

        // 4. Accepted methods & security
        html +=
            '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1rem;">' +
                '<div class="gm-dim gm-sub-methods" style="font-size:.78rem;">' +
                    (t('gm_sub_methods') || 'Accepted payments: Cards (Visa, Mastercard, Amex), Cartes Bancaires, Apple Pay, Google Pay, PayPal, Alipay, Amazon Pay, Klarna, iDEAL, Bancontact, EPS, BLIK, MB WAY, Pix, Satispay, Multibanco, MobilePay, WeChat Pay, Revolut Pay, Samsung Pay, Kakao Pay, Naver Pay, PAYCO, Link, and more.') +
                '</div>' +
                '<div class="gm-dim" style="font-size:.75rem; margin-top:.35rem;">' +
                    '<i class="ph ph-shield-check"></i> ' + (t('gm_sub_security') || 'Payments are processed and secured by the payment provider. The site administrator never has access to your bank details.') +
                    ' • <a href="terms.html" style="color:var(--text-muted); text-decoration:underline;">' + (t('footer_terms') || 'Terms & Conditions') + '</a>' +
                '</div>' +
            '</div>';

        container.innerHTML = html;

        // Wire tier buttons
        container.querySelectorAll('[data-gm-sub-plan]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var planKey = btn.getAttribute('data-gm-sub-plan');
                startCheckout(planKey, null, btn);
            });
        });

        // Wire custom amount button
        var customBtn = document.getElementById('donation-custom-btn');
        var customInput = document.getElementById('donation-custom-input');
        var customErr = document.getElementById('donation-custom-error');
        if (customBtn && customInput) {
            customBtn.addEventListener('click', function () {
                var val = parseFloat(customInput.value);
                if (isNaN(val) || val < 2 || val > 100 || !Number.isInteger(Math.round(val * 100) / 100)) {
                    if (customErr) customErr.style.display = 'block';
                    return;
                }
                if (customErr) customErr.style.display = 'none';
                var cents = Math.round(val * 100);
                startCheckout('donation_custom', cents, customBtn);
            });
            customInput.addEventListener('input', function () {
                if (customErr) customErr.style.display = 'none';
            });
        }
    }

    // ── Return Handling (?checkout=success or ?checkout=cancel) ───────────────
    async function handleReturn(container, search) {
        var params = new URLSearchParams(search === undefined ? window.location.search : search);
        var mode = params.get('checkout');
        var sessionId = params.get('session_id');

        if (search === undefined && (mode === 'success' || mode === 'cancel')) {
            try {
                window.history.replaceState({}, '', window.location.pathname + window.location.hash);
            } catch (e) { /* non fatal */ }
        }

        if (mode === 'cancel') {
            showToast(t('gm_sub_cancelled') || 'Donation cancelled.', 'info');
            return;
        }

        if (mode === 'success') {
            showToast(t('gm_donate_thanks_title') || 'Thank you for supporting the app!', 'success');
            if (container) {
                container.innerHTML =
                    '<div class="gm-card gm-card-padded gm-section" style="text-align:center; padding:3rem 1.5rem; max-width:540px; margin:2rem auto;">' +
                        '<div style="width:64px; height:64px; border-radius:50%; background:var(--accent-soft, rgba(99,102,241,0.15)); color:var(--accent, #6366f1); display:flex; align-items:center; justify-content:center; font-size:2rem; margin:0 auto 1.25rem auto;">' +
                            '<i class="ph-fill ph-coffee"></i>' +
                        '</div>' +
                        '<h2 style="font-size:1.4rem; font-weight:800; color:var(--fg); margin:0 0 0.5rem 0;">' + (t('gm_donate_thanks_title') || 'Thank you for your support!') + '</h2>' +
                        '<p class="gm-dim" style="font-size:.92rem; line-height:1.6; margin:0 0 1.5rem 0;">' + (t('gm_donate_thanks_body') || 'Your donation helps keep the servers running and the AI scans available for everyone.') + '</p>' +
                        '<button class="gm-btn gm-btn-primary" id="btn-return-donation"><i class="ph ph-arrow-left"></i> Back to Donations</button>' +
                    '</div>';
                var retBtn = document.getElementById('btn-return-donation');
                if (retBtn) retBtn.addEventListener('click', load);
            }
        }
    }

    function loadingHtml() {
        return '<div class="gm-empty"><i class="ph ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">' + (t('loading') || 'Loading') + '…</div></div>';
    }

    function errorHtml(msg) {
        return '<div class="gm-empty">' +
            '<i class="ph-duotone ph-warning-circle gm-icon"></i>' +
            '<div class="gm-empty-title">' + (t('gm_sub_load_error') || 'Could not load the donation page') + '</div>' +
            '<div class="gm-empty-hint">' + esc(msg) + '</div>' +
            '<button class="gm-btn gm-btn-primary" id="subscription-retry" style="margin-top:.5rem;"><i class="ph ph-arrow-clockwise"></i> ' + (t('gm_sub_retry') || 'Retry') + '</button>' +
        '</div>';
    }

    function deniedHtml() {
        return '<div class="gm-empty">' +
            '<i class="ph-duotone ph-shield-warning gm-icon"></i>' +
            '<div class="gm-empty-title">' + (t('gm_sub_denied') || 'Admins only') + '</div>' +
        '</div>';
    }

    function paymentsDisabledHtml() {
        return '<div class="gm-empty">' +
            '<i class="ph-duotone ph-coffee gm-icon"></i>' +
            '<div class="gm-empty-title">' + (t('gm_donate_disabled_title') || 'Donations are disabled') + '</div>' +
            '<div class="gm-empty-hint">' + (t('gm_donate_disabled_body') || 'Donations are disabled on the demonstration server.') + '</div>' +
        '</div>';
    }

    window.GM_SUBSCRIPTION = {
        load: load,
        handleReturn: handleReturn,
        _plans: DONATION_TIERS,
        _state: state,
        _redirectTo: redirectTo
    };

})();
