/**
 * subscription.js — Abonnement en self-service (onglet « Subscription »).
 * Visible pour les guild_admin et le super_admin (sur n'importe quel tenant).
 * Paiement via Revolut Merchant Web SDK (embedded checkout) : CB, Revolut Pay,
 * Apple Pay, Google Pay. La source de vérité reste le webhook Revolut
 * (gm-revolut-webhook) ; gm-order-status permet de rafraîchir l'UI dès que
 * Revolut confirme l'ordre côté serveur.
 * Chargé à la demande par app.js via window.GM_SUBSCRIPTION.load().
 */
(function () {

    var esc = (window.GM && window.GM.escapeHTML) || function (s) { return s; };
    var t = function (k) { return window.GM_I18N ? window.GM_I18N.t(k) : k; };

    var PLANS = [
        { key: '1m', label: '1 Month',  price: '6.99',  period: 'one-time', tag: null },
        { key: '3m', label: '3 Months', price: '16.99', period: 'one-time', tag: 'Save 19%' },
        { key: '6m', label: '6 Months', price: '27.99', period: 'one-time', tag: 'Save 33%' },
        { key: '12m', label: '12 Months', price: '47.99', period: 'one-time', tag: 'Save 43%' },
        { key: 'lifetime', label: 'Lifetime', price: '89.00', period: 'one-time', tag: 'Best value' }
    ];

    var POLL_INTERVAL_MS = 2000;
    var POLL_ATTEMPTS = 15;

    var state = {
        config: null,       // { publicKey, mode, configured }
        widget: null,       // EmbeddedCheckoutInstance (destroy)
        polling: false
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

        state.config = null;
        state.polling = false;
        container.innerHTML = loadingHtml();

        try {
            var db = getDb();
            if (!db || !db.functions) throw new Error('no_db');
            var res = await db.functions.invoke('gm-create-order', { body: { action: 'config' } });
            var data = res.data || {};
            if (!data.ok) throw new Error(data.error || 'config_failed');
            state.config = data;
            render(container);
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
        return '<div class="gm-card gm-card-padded gm-sub-plan-card' + featured + '" style="flex:1; min-width:180px; max-width:220px; display:flex; flex-direction:column; gap:.4rem; position:relative;">' +
            (plan.tag ? '<span style="position:absolute; top:-10px; right:12px; background:var(--accent); color:#fff; font-size:.65rem; font-weight:800; padding:2px 8px; border-radius:99px; letter-spacing:.04em;">' + esc(plan.tag) + '</span>' : '') +
            '<div class="gm-dim" style="font-size:.75rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase;">' + esc(plan.label) + '</div>' +
            '<div style="font-size:1.6rem; font-weight:800; font-variant-numeric:tabular-nums; color:var(--fg);">€' + esc(plan.price) + '</div>' +
            '<div class="gm-dim" style="font-size:.75rem; margin-bottom:.35rem;">' + (plan.period === 'one-time' ? (t('gm_sub_one_time') || 'one-time payment') : esc(plan.period)) + '</div>' +
            '<button class="gm-btn gm-btn-primary gm-sub-buy" data-gm-sub-plan="' + plan.key + '" style="margin-top:auto;">' +
                '<i class="ph ph-credit-card"></i> ' + (t('gm_sub_subscribe') || 'Subscribe') +
            '</button>' +
        '</div>';
    }

    // ── Widget Revolut (embedded checkout) ───────────────────────────────────
    function loadEmbedScript(mode) {
        return new Promise(function (resolve, reject) {
            if (window.RevolutCheckout) return resolve(window.RevolutCheckout);
            var base = mode === 'sandbox'
                ? 'https://sandbox-merchant.revolut.com/embed.js'
                : 'https://merchant.revolut.com/embed.js';
            var s = document.createElement('script');
            s.id = 'revolut-embed';
            s.src = base;
            s.async = true;
            s.onload = function () { resolve(window.RevolutCheckout || null); };
            s.onerror = function () { reject(new Error('embed_failed')); };
            document.head.appendChild(s);
        });
    }

    async function openWidget(planKey, container) {
        var cfg = state.config;
        if (!cfg || !cfg.configured) {
            showToast(t('gm_sub_not_configured') || 'Payments are not configured yet.', 'error');
            return;
        }
        if (!cfg.publicKey) {
            showToast(t('gm_sub_not_configured') || 'Payments are not configured yet.', 'error');
            return;
        }

        var slot = document.getElementById('subscription-widget');
        if (!slot) return;

        if (state.widget && state.widget.destroy) {
            try { state.widget.destroy(); } catch (e) { /* ignore */ }
            state.widget = null;
        }

        slot.style.display = 'block';
        slot.innerHTML = '<div class="gm-empty"><i class="ph ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">' + (t('loading') || 'Loading') + '…</div></div>';

        var sdk;
        try {
            sdk = await loadEmbedScript(cfg.mode);
            if (!sdk) throw new Error('embed_failed');
        } catch (err) {
            slot.style.display = 'none';
            showToast(t('gm_sub_widget_error') || 'Could not open the payment widget.', 'error');
            render(container);
            return;
        }

        var guildId = getGuildId();
        var db = getDb();

        try {
            state.widget = await sdk.embeddedCheckout({
                publicToken: cfg.publicKey,
                mode: cfg.mode,
                locale: 'auto',
                target: slot,
                createOrder: async function () {
                    var res = await db.functions.invoke('gm-create-order', {
                        body: { action: 'create', guildId: guildId, plan: planKey }
                    });
                    var data = res.data || {};
                    if (!data.ok || !data.token) throw new Error(data.error || 'order_failed');
                    return { publicId: data.token };
                },
                onSuccess: function (payload) {
                    var token = (payload && payload.orderId) || null;
                    showToast(t('gm_sub_processing') || 'Processing payment…', 'info');
                    if (token) pollStatus(token, container);
                },
                onError: function () {
                    showToast(t('gm_sub_payment_failed') || 'Payment failed, please try again.', 'error');
                },
                onCancel: function () {
                    slot.style.display = 'none';
                    slot.innerHTML = '';
                    render(container);
                }
            });
        } catch (err) {
            slot.style.display = 'none';
            showToast(t('gm_sub_widget_error') || 'Could not open the payment widget.', 'error');
            render(container);
        }
    }

    // ── Confirmation : poll gm-order-status puis refresh local ──────────────
    async function pollStatus(token, container) {
        if (state.polling) return;
        state.polling = true;
        var db = getDb();
        var applied = false;
        var attempts = 0;

        while (attempts < POLL_ATTEMPTS) {
            attempts++;
            try {
                var res = await db.functions.invoke('gm-order-status', { body: { orderId: token } });
                var data = res.data || {};
                if (data.ok && (data.applied === true || data.state === 'completed')) {
                    applied = true;
                    break;
                }
            } catch (err) { /* keep polling */ }
            await sleep(POLL_INTERVAL_MS);
        }

        state.polling = false;

        if (applied) {
            await refreshGuildsData();
            showToast(t('gm_sub_success') || 'Subscription activated - thank you!', 'success');
        } else {
            // Webhook will apply it shortly; refresh anyway so the user sees the truth.
            await refreshGuildsData();
            showToast(t('gm_sub_waiting') || 'Payment received - activation in progress…', 'info');
        }

        var slot = document.getElementById('subscription-widget');
        if (slot) {
            slot.style.display = 'none';
            slot.innerHTML = '';
        }
        if (state.widget && state.widget.destroy) {
            try { state.widget.destroy(); } catch (e) { /* ignore */ }
            state.widget = null;
        }
        render(container);
    }

    // ── Refresh du cache local (miroir de fetchGuilds dans app.js) ──────────
    async function refreshGuildsData() {
        var db = getDb();
        if (!db) return;
        try {
            var res = await db.from('guilds')
                .select('id, subscription_type, subscription_end, server_number')
                .order('id');
            if (res.error || !res.data || res.data.length === 0) return;
            window.guildsList = res.data.map(function (g) { return g.id; });
            window.guildsData = {};
            res.data.forEach(function (g) {
                var sNum = g.server_number || localStorage.getItem('gm_server_number_' + g.id) || '';
                window.guildsData[g.id] = {
                    type: g.subscription_type || 'Unlimited',
                    end: g.subscription_end || null,
                    server_number: sNum
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
                '<div style="display:flex; gap:1rem; flex-wrap:wrap; align-items:stretch; justify-content:center;">' +
                    PLANS.map(planCardHtml).join('') +
                '</div>' +
                '<div class="gm-dim" style="font-size:.75rem; margin-top:.9rem;">' + (t('gm_sub_methods') || 'Accepted payments: Card, Apple Pay, Google Pay and Revolut Pay.') + '</div>' +
                '<div class="gm-dim" style="font-size:.75rem; margin-top:.25rem;"><i class="ph ph-shield-check"></i> ' + (t('gm_sub_security') || 'Payments are processed and secured by Revolut. The site administrator never has access to your bank details.') + '</div>' +
            '</div>' +
            '<div id="subscription-widget" class="gm-sub-widget" style="display:none;"></div>';

        container.innerHTML = html;

        container.querySelectorAll('[data-gm-sub-plan]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                openWidget(btn.getAttribute('data-gm-sub-plan'), container);
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

    window.GM_SUBSCRIPTION = {
        load: load,
        _plans: PLANS,
        _state: state
    };

})();
