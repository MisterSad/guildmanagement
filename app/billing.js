/**
 * billing.js: subscription status + Paddle checkout (saas_strategy.md §8).
 *
 * STAGED + degrades gracefully. The subscription lives on the guilds table
 * (multi-tenant migration), absent from current production: this module
 * detects that and renders an "activates with the multi-tenant update" notice
 * instead of erroring. It is also inert until Paddle is configured in
 * config.js (empty client token / price id => the Subscribe button is disabled
 * and a "billing not configured" hint is shown). See docs/paddle-setup.md.
 *
 * Renders into:
 *   [data-gmt-billing-banner]  a slim status banner (trial left / past due /
 *                              read-only) shown to R5 and R4.
 *   #billing-area              the full subscription card (R5 admin page only).
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };

    var paddleReady = false;
    var lastGuild = null;

    window.RAD_BILLING = { load: load };

    function cfg() { return window.GMT_CONFIG || {}; }
    function paddleConfigured() { return !!(cfg().PADDLE_CLIENT_TOKEN && cfg().PADDLE_PRICE_ID); }

    function daysLeft(iso) {
        if (!iso) return null;
        var ms = new Date(iso).getTime() - Date.now();
        if (isNaN(ms)) return null;
        return Math.max(0, Math.ceil(ms / 86400000));
    }

    async function load() {
        var banner = document.querySelector('[data-gmt-billing-banner]');
        var card = document.getElementById('billing-area');
        if (!db || (!banner && !card)) return;

        var info = window.RAD.sessionInfo ? await window.RAD.sessionInfo() : null;
        var guildId = info && info.guildId;

        var res = await db.from('guilds').select('subscription_status, trial_ends_at, management_url').limit(1).maybeSingle();
        if (res.error) {
            var code = res.error.code || '';
            var msg = res.error.message || '';
            var notReady = code === 'PGRST205' || code === '42P01' || /could not find the table|does not exist|schema cache/i.test(msg);
            if (banner) banner.innerHTML = '';
            if (card) {
                card.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-' + (notReady ? 'rocket-launch' : 'warning') + ' gm-icon"></i>' +
                    '<div class="gm-empty-title">' + esc(notReady ? t('billing_not_ready') : t('toast_err_generic')) + '</div>' +
                    (notReady ? '<div class="gm-empty-hint">' + esc(t('billing_not_ready_hint')) + '</div>' : '') + '</div>';
            }
            return;
        }

        var guild = res.data || { subscription_status: 'trialing', trial_ends_at: null, management_url: null };
        guild.guild_id = guildId;
        lastGuild = guild;
        if (banner) renderBanner(banner, guild);
        if (card) renderCard(card, guild);
    }

    function renderBanner(el, g) {
        var s = g.subscription_status;
        var html = '';
        if (s === 'trialing') {
            var d = daysLeft(g.trial_ends_at);
            if (d !== null) html = bannerHtml('info', 'ph-clock', t('billing_trial_banner').replace('{n}', d));
        } else if (s === 'past_due') {
            html = bannerHtml('warn', 'ph-warning', t('billing_past_due_banner'));
        } else if (s === 'read_only') {
            html = bannerHtml('warn', 'ph-lock', t('billing_readonly_banner'));
        } else if (s === 'canceled') {
            html = bannerHtml('warn', 'ph-lock', t('billing_canceled_banner'));
        }
        el.innerHTML = html;
    }

    function bannerHtml(kind, icon, text) {
        var bg = kind === 'warn' ? 'rgba(239,68,68,0.12)' : 'rgba(99,102,241,0.12)';
        var col = kind === 'warn' ? 'var(--danger)' : 'var(--primary)';
        return '<div style="display:flex; align-items:center; gap:.5rem; padding:.5rem .9rem; background:' + bg + '; color:' + col + '; border-radius:10px; font-size:.85rem; margin:.5rem 0;">' +
            '<i class="ph ' + icon + '"></i><span>' + esc(text) + '</span></div>';
    }

    function statusChip(s) {
        var map = {
            trialing: ['gm-chip-info', 'billing_status_trialing'],
            active:   ['gm-chip-success', 'billing_status_active'],
            past_due: ['gm-chip-accent', 'billing_status_past_due'],
            read_only:['gm-chip', 'billing_status_read_only'],
            canceled: ['gm-chip', 'billing_status_canceled']
        };
        var m = map[s] || ['gm-chip', 'billing_status_active'];
        return '<span class="gm-chip ' + m[0] + '">' + esc(t(m[1])) + '</span>';
    }

    function renderCard(el, g) {
        var s = g.subscription_status;
        var configured = paddleConfigured();
        var isPaying = s === 'active' || s === 'past_due';

        var lines = '<div class="gm-row" style="justify-content:space-between; align-items:center;">' +
            '<div class="gm-col" style="gap:.25rem;">' +
                '<div class="gm-row" style="gap:.5rem; align-items:center;"><span class="gm-dim">' + esc(t('billing_plan')) + '</span> <strong>9,99 €/' + esc(t('billing_per_month')) + '</strong> ' + statusChip(s) + '</div>';
        if (s === 'trialing') {
            var d = daysLeft(g.trial_ends_at);
            if (d !== null) lines += '<div class="gm-dim" style="font-size:.85rem;">' + esc(t('billing_trial_banner').replace('{n}', d)) + '</div>';
        }
        lines += '</div></div>';

        var actions = '<div class="gm-row" style="gap:.5rem; margin-top:1rem; flex-wrap:wrap;">';
        if (isPaying) {
            actions += g.management_url
                ? '<a class="gm-btn gm-btn-primary gm-btn-sm" href="' + esc(g.management_url) + '" target="_blank" rel="noopener"><i class="ph ph-gear"></i> <span>' + t('billing_manage') + '</span></a>'
                : '<button class="gm-btn gm-btn-ghost gm-btn-sm" disabled><i class="ph ph-gear"></i> <span>' + t('billing_manage') + '</span></button>';
        } else {
            actions += '<button class="gm-btn gm-btn-primary gm-btn-sm" data-billing-subscribe' + (configured ? '' : ' disabled') + '><i class="ph ph-rocket-launch"></i> <span>' + t('billing_subscribe') + '</span></button>';
        }
        actions += '</div>';
        if (!configured) actions += '<div class="gm-dim" style="font-size:.8rem; margin-top:.5rem;"><i class="ph ph-info"></i> ' + esc(t('billing_not_configured')) + '</div>';

        el.innerHTML = lines + actions;

        var sub = el.querySelector('[data-billing-subscribe]');
        if (sub) sub.addEventListener('click', function () { openCheckout(g); });
    }

    // ── Paddle.js (lazy) ────────────────────────────────────────────────────────
    function loadPaddleJs() {
        return new Promise(function (resolve, reject) {
            if (window.Paddle) { resolve(); return; }
            var s = document.createElement('script');
            s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    async function ensurePaddle() {
        if (paddleReady) return true;
        if (!paddleConfigured()) return false;
        try {
            await loadPaddleJs();
            if (cfg().PADDLE_ENV === 'sandbox' && window.Paddle.Environment) window.Paddle.Environment.set('sandbox');
            window.Paddle.Initialize({ token: cfg().PADDLE_CLIENT_TOKEN });
            paddleReady = true;
            return true;
        } catch (e) {
            window.RAD.showToast(t('billing_paddle_load_failed'), 'error');
            return false;
        }
    }

    async function openCheckout(g) {
        if (!(await ensurePaddle())) {
            window.RAD.showToast(t('billing_not_configured'), 'info');
            return;
        }
        var opts = {
            items: [{ priceId: cfg().PADDLE_PRICE_ID, quantity: 1 }],
            settings: { displayMode: 'overlay' }
        };
        if (g.guild_id) opts.customData = { guild_id: g.guild_id };
        try {
            window.Paddle.Checkout.open(opts);
        } catch (e) {
            window.RAD.showToast(t('billing_paddle_load_failed'), 'error');
        }
    }

})();
