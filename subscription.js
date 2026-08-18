/**
 * subscription.js — Abonnement en self-service (onglet « Subscription »).
 * Visible pour les guild_admin et le super_admin (sur n'importe quel tenant).
 * Paiement via une Checkout Session hébergée (redirection Stripe) : CB,
 * Apple Pay, Google Pay, PayPal. La source de vérité reste le webhook
 * (gm-stripe-webhook) ; gm-order-status permet de rafraîchir l'UI dès que
 * Stripe confirme le paiement côté serveur.
 * Chargé à la demande par app.js via window.GM_SUBSCRIPTION.load().
 */
(function () {

    var esc = (window.GM && window.GM.escapeHTML) || function (s) { return s; };
    var t = function (k) { return window.GM_I18N ? window.GM_I18N.t(k) : k; };

    var PLANS = [
        { key: '1m', label: '1 Month',  price: '9.99',  period: 'one-time', tag: null },
        { key: '3m', label: '3 Months', price: '24.99', period: 'one-time', tag: 'Save ~17%' },
        { key: '6m', label: '6 Months', price: '44.99', period: 'one-time', tag: 'Save ~25%' },
        { key: '12m', label: '12 Months', price: '74.99', period: 'one-time', tag: 'Save ~37% - best value' }
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

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function showToast(msg, type) {
        if (window.GM && window.GM.showToast) window.GM.showToast(msg, type);
    }

    // ── Chargement ───────────────────────────────────────────────────────────
    async function load() {
        var container = document.getElementById('subscription-container');
        if (!container) return;

        if (!isAdminRole()) {
            container.innerHTML = deniedHtml();
            return;
        }

        // Guilds with payments disabled (e.g. the public DEMO preview tenant)
        // get a read-only notice instead of the purchase plans.
        var guildId = getGuildId();
        if (!window.guildsData || !window.guildsData[guildId]) {
            // guildsData not loaded yet (deep link): refresh it first so the
            // payments_disabled flag is authoritative before rendering plans.
            try {
                await refreshGuildsData();
            } catch (err) { /* fall through to plans; server gates at create */ }
        }
        if (window.GM.isPaymentsDisabled(guildId)) {
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

    // ── Statut actuel de la guilde courante ─────────────────────────────────
    function statusCardHtml(guildId) {
        var sub = (window.guildsData && window.guildsData[guildId]) || { type: 'Unlimited', end: null };
        var icon = 'ph-infinity';
        var label = '';
        var desc = '';

        if (sub.type === 'Lifetime') {
            icon = 'ph-infinity';
            label = 'Lifetime';
            desc = 'Lifetime access - never expires.';
        } else if (sub.type === 'Unlimited') {
            icon = 'ph-infinity';
            label = 'Unlimited';
            desc = 'Unlimited access.';
        } else if (sub.type === 'Premium' && sub.end) {
            var endMs = new Date(sub.end).getTime();
            if (endMs > Date.now()) {
                var days = Math.floor((endMs - Date.now()) / (1000 * 60 * 60 * 24));
                var hours = Math.floor(((endMs - Date.now()) % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                icon = 'ph-sparkle';
                label = 'Active';
                desc = 'Active until ' + esc(sub.end.split('T')[0]) + ' - ' + days + 'd ' + hours + 'h remaining.';
            } else {
                icon = 'ph-lock-keyhole';
                label = 'Expired';
                desc = 'Your subscription has expired. Renew below to restore write access.';
            }
        } else {
            icon = 'ph-lock-keyhole';
            label = 'Expired';
            desc = 'No active subscription. Renew below to restore write access.';
        }

        return '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap;">' +
            '<div style="width:48px; height:48px; border-radius:12px; background:var(--accent-soft); color:var(--accent); display:flex; align-items:center; justify-content:center; font-size:1.5rem; flex-shrink:0;">' +
                '<i class="ph-fill ' + icon + '"></i>' +
            '</div>' +
            '<div style="flex:1; min-width:200px;">' +
                '<div class="gm-member-pseudo" style="font-weight:700; font-size:1.05rem;">' + esc(guildId) + ' - ' + label + '</div>' +
                '<div class="gm-dim" style="font-size:.85rem;">' + desc + '</div>' +
            '</div>' +
            '<div style="display:flex; gap:.5rem; align-items:center;">' +
                '<span class="gm-chip" style="background:var(--accent-soft); color:var(--accent); font-weight:700; font-size:.72rem; letter-spacing:.03em;">' + esc(guildId) + '</span>' +
            '</div>' +
        '</div>';
    }

    // ── Cartes de plans ──────────────────────────────────────────────────────
    function planCardHtml(plan) {
        var featured = plan.tag ? ' gm-sub-plan-featured' : '';
        return '<div class="gm-sub-plan-card' + featured + '">' +
            (plan.tag ? '<span class="gm-sub-plan-tag">' + esc(plan.tag) + '</span>' : '') +
            '<div class="gm-sub-plan-label">' + esc(plan.label) + '</div>' +
            '<div class="gm-sub-plan-price">€' + esc(plan.price) + '</div>' +
            '<div class="gm-sub-plan-period">' + (plan.period === 'one-time' ? (t('gm_sub_one_time') || 'one-time payment') : esc(plan.period)) + '</div>' +
            '<button class="gm-btn gm-btn-primary gm-sub-buy" data-gm-sub-plan="' + plan.key + '">' +
                '<i class="ph ph-credit-card"></i> ' + (t('gm_sub_subscribe') || 'Subscribe') +
            '</button>' +
        '</div>';
    }

    // ── Démarrer un paiement : créer la session puis rediriger ──────────────
    // Redirect goes through the public API so tests can stub it without
    // touching the read-only window.location.assign in jsdom.
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

    async function startCheckout(planKey, container) {
        var cfg = state.config;
        if (!cfg || !cfg.configured) {
            showToast(t('gm_sub_not_configured') || 'Payments are not configured yet.', 'error');
            return;
        }
        if (state.busy) return;
        state.busy = true;

        var btn = container.querySelector('[data-gm-sub-plan="' + planKey + '"]');
        var origText = '';
        if (btn) {
            origText = btn.textContent;
            btn.disabled = true;
            btn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> <span>Redirecting...</span>';
        }

        var guildId = getGuildId();
        var db = getDb();
        var returnUrl = window.location.href.split('?')[0];

        try {
            var res = await db.functions.invoke('gm-create-order', {
                body: { action: 'create', guildId: guildId, plan: planKey, returnUrl: returnUrl }
            });
            var data = res.data || {};
            if (!data.ok || !data.url) throw new Error(data.error || 'order_failed');
            // Hosted checkout: hand the browser over to Stripe.
            startCheckoutRedirect(data.url);
        } catch (err) {
            state.busy = false;
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText;
            }
            showToast(t('gm_sub_widget_error') || 'Could not start the payment.', 'error');
        }
    }

    // ── Confirmation au retour de Stripe : poll gm-order-status ────────────
    async function confirmCheckout(sessionId, container) {
        var db = getDb();
        var applied = false;
        var attempts = 0;

        while (attempts < 15) {
            attempts++;
            try {
                var res = await db.functions.invoke('gm-order-status', { body: { sessionId: sessionId } });
                var data = res.data || {};
                if (data.ok && (data.applied === true || data.state === 'completed')) {
                    applied = true;
                    break;
                }
            } catch (err) { /* keep polling */ }
            await sleep(2000);
        }

        if (applied) {
            await refreshGuildsData();
            showToast(t('gm_sub_success') || 'Subscription activated - thank you!', 'success');
        } else {
            // Webhook will apply it shortly; refresh anyway so the user sees the truth.
            await refreshGuildsData();
            showToast(t('gm_sub_waiting') || 'Payment received - activation in progress…', 'info');
        }

        render(container);
    }

    // ── Refresh du cache local (miroir de fetchGuilds dans app.js) ──────────
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

    // ── Rendu principal ──────────────────────────────────────────────────────
    function render(container) {
        var guildId = getGuildId();
        var html = statusCardHtml(guildId);
        html +=
            '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1rem;">' +
                '<div class="gm-dim" style="font-size:.75rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; margin-bottom:.75rem;">' + (t('gm_sub_plans_title') || 'Subscription plans') + '</div>' +
                '<div class="gm-sub-plans-grid">' +
                    PLANS.map(planCardHtml).join('') +
                '</div>' +
                '<div class="gm-dim gm-sub-methods" style="font-size:.78rem; margin-top:.9rem;">' + (t('gm_sub_methods') || 'Accepted payments: Cards (Visa, Mastercard, Amex), Cartes Bancaires, Apple Pay, Google Pay, PayPal, Alipay, Amazon Pay, Klarna, iDEAL, Bancontact, EPS, BLIK, MB WAY, Pix, Satispay, Multibanco, MobilePay, WeChat Pay, Revolut Pay, Samsung Pay, Kakao Pay, Naver Pay, PAYCO, Link, and more.') + '</div>' +
                '<div class="gm-dim" style="font-size:.75rem; margin-top:.25rem;"><i class="ph ph-shield-check"></i> ' + (t('gm_sub_security') || 'Payments are processed and secured by the payment provider. The site administrator never has access to your bank details.') + '</div>' +
            '</div>' +
            '<div id="subscription-widget" class="gm-sub-widget" style="display:none;"></div>';

        container.innerHTML = html;

        container.querySelectorAll('[data-gm-sub-plan]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                startCheckout(btn.getAttribute('data-gm-sub-plan'), container);
            });
        });
    }

    function loadingHtml() {
        return '<div class="gm-empty"><i class="ph ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">' + (t('loading') || 'Loading') + '…</div></div>';
    }

    function errorHtml(msg) {
        return '<div class="gm-empty">' +
            '<i class="ph-duotone ph-warning-circle gm-icon"></i>' +
            '<div class="gm-empty-title">' + (t('gm_sub_load_error') || 'Could not load the subscription page') + '</div>' +
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
            '<i class="ph-duotone ph-infinity gm-icon"></i>' +
            '<div class="gm-empty-title">' + (t('gm_sub_disabled_title') || 'Payments are disabled') + '</div>' +
            '<div class="gm-empty-hint">' + (t('gm_sub_disabled_hint') || 'This guild runs without subscriptions. No payment is required.') + '</div>' +
        '</div>';
    }

    // ── Traitement du retour de Stripe (page rechargée avec ?checkout=) ─────
    async function handleReturn(container, search) {
        var params = new URLSearchParams(search === undefined ? window.location.search : search);
        var mode = params.get('checkout');
        var sessionId = params.get('session_id');

        // Nettoyer l'URL après lecture : sans ça, le ?checkout= success/cancel
        // resterait dans la barre d'adresse et chaque rechargement de page
        // ramènerait l'utilisateur sur l'onglet Subscription.
        if (search === undefined && (mode === 'success' || mode === 'cancel')) {
            try {
                window.history.replaceState({}, '', window.location.pathname + window.location.hash);
            } catch (e) { /* non fatal */ }
        }

        if (mode === 'cancel') {
            showToast(t('gm_sub_cancelled') || 'Payment cancelled.', 'info');
            return;
        }
        if (mode === 'success' && sessionId) {
            showToast(t('gm_sub_processing') || 'Processing payment…', 'info');
            await confirmCheckout(sessionId, container);
        }
    }

    window.GM_SUBSCRIPTION = {
        load: load,
        handleReturn: handleReturn,
        _plans: PLANS,
        _state: state,
        _redirectTo: redirectTo
    };

})();
