/**
 * src/modules/subscription/subscription-view.ts
 *
 * TypeScript port of subscription.js — "Buy Me a Coffee" voluntary
 * donations panel (Command Center, any admin-side role).
 *
 * 1:1 port: same markup, same DOM ids/classes, same behavior. Still reads
 * window.GM.* for pieces owned by the legacy scripts (db, active guild,
 * role, toast, escapeHTML, payments-disabled check) — migrating those is a
 * separate module-by-module step, not part of this one.
 *
 * Exposed on window.GM_SUBSCRIPTION so app.js's existing call site
 * (window.GM_SUBSCRIPTION.load() on tab-subscription) keeps working
 * unchanged.
 */

import { SubscriptionService } from './subscription.service';

interface DonationTier {
  key: string;
  label: string;
  price: string;
  cents: number;
  tag: string | null;
  icon: string;
}

const DONATION_TIERS: DonationTier[] = [
  { key: 'donation_2', label: 'Buy a Coffee', price: '2', cents: 200, tag: null, icon: 'ph-coffee' },
  { key: 'donation_5', label: 'Buy 2 Coffees', price: '5', cents: 500, tag: 'Popular', icon: 'ph-coffee' },
  { key: 'donation_10', label: 'Buy a Lunch', price: '10', cents: 1000, tag: null, icon: 'ph-heart' },
];

interface SubscriptionState {
  config: { ok: boolean; mode?: string; configured?: boolean; error?: string } | null;
  busy: boolean;
}

function gm(): any {
  return (window as any).GM || {};
}

function esc(s: unknown): string {
  const fn = gm().escapeHTML;
  return typeof fn === 'function' ? fn(s) : String(s ?? '');
}

function t(key: string): string {
  const i18n = (window as any).GM_I18N;
  return i18n ? i18n.t(key) : key;
}

function showToast(msg: string, type: string): void {
  if (gm().showToast) gm().showToast(msg, type);
}

function getDb(): any {
  return gm().db || null;
}

function getGuildId(): string {
  return gm().getActiveGuild ? gm().getActiveGuild() : 'ALPHA';
}

function isAdminRole(): boolean {
  // Any admin-side role sees this, not an allowlist of specific ones --
  // the exact same bug already fixed once in shell.js's visibleNavItems()
  // (server_admin silently excluded by an allowlist of just
  // super_admin/guild_admin) existed here too, independently, since this
  // module has its own separate gate. Excluding by role instead of
  // allowlisting means a future admin sub-role can't hit it again either.
  const role = gm().roleFromStorage ? gm().roleFromStorage() : null;
  return !!role && role !== 'member';
}

export class SubscriptionView {
  private static state: SubscriptionState = { config: null, busy: false };

  // Stubbable for tests, mirrors legacy _redirectTo.
  public static redirectTo(url: string): void {
    window.location.assign(url);
  }

  private static startCheckoutRedirect(url: string): void {
    const bridge = (window as any).GM_SUBSCRIPTION;
    if (bridge && bridge._redirectTo) {
      bridge._redirectTo(url);
    } else {
      SubscriptionView.redirectTo(url);
    }
  }

  public static async load(): Promise<void> {
    const container = document.getElementById('subscription-container');
    if (!container) return;

    if (!isAdminRole()) {
      container.innerHTML = SubscriptionView.deniedHtml();
      return;
    }

    const guildId = getGuildId();
    const w = window as any;
    if (!w.guildsData || !w.guildsData[guildId]) {
      try {
        await SubscriptionService.refreshGuildsData();
      } catch {
        /* ignore */
      }
    }

    if (gm().isPaymentsDisabled && gm().isPaymentsDisabled(guildId)) {
      container.innerHTML = SubscriptionView.paymentsDisabledHtml();
      return;
    }

    SubscriptionView.state.config = null;
    container.innerHTML = SubscriptionView.loadingHtml();

    try {
      const db = getDb();
      if (!db || !db.functions) throw new Error('no_db');
      const data = await SubscriptionService.getConfig();
      if (!data.ok) throw new Error(data.error || 'config_failed');
      SubscriptionView.state.config = data;
      SubscriptionView.render(container);
      await SubscriptionView.handleReturn(container);
    } catch (err: any) {
      container.innerHTML = SubscriptionView.errorHtml((err && err.message) || 'load_failed');
      SubscriptionView.wireRetry(container);
    }
  }

  private static wireRetry(container: HTMLElement): void {
    const btn = document.getElementById('subscription-retry');
    if (btn) btn.addEventListener('click', () => SubscriptionView.load());
  }

  private static freeAppStatusCardHtml(): string {
    return (
      '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1.25rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap;">' +
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
      '</div>'
    );
  }

  private static tierCardHtml(tier: DonationTier): string {
    const featured = tier.tag ? ' gm-sub-plan-featured' : '';
    return (
      '<div class="gm-sub-plan-card' + featured + '">' +
      (tier.tag ? '<span class="gm-sub-plan-tag">' + esc(tier.tag) + '</span>' : '') +
      '<div class="gm-sub-plan-label">' + esc(tier.label) + '</div>' +
      '<div class="gm-sub-plan-price">€' + esc(tier.price) + '</div>' +
      '<div class="gm-sub-plan-period">' + (t('gm_sub_one_time') || 'voluntary one-time donation') + '</div>' +
      '<button class="gm-btn gm-btn-primary gm-sub-buy" data-gm-sub-plan="' + tier.key + '">' +
      '<i class="ph ' + tier.icon + '"></i> ' + (t('gm_sub_subscribe') || 'Donate') + ' €' + esc(tier.price) +
      '</button>' +
      '</div>'
    );
  }

  private static transparencyCardHtml(): string {
    return (
      '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1.25rem;">' +
      '<div style="font-size:.95rem; font-weight:700; color:var(--fg); margin-bottom:.75rem; display:flex; align-items:center; gap:0.5rem;">' +
      '<i class="ph ph-heart" style="color:var(--accent, #6366f1);"></i> ' +
      '<span>Why your support matters</span>' +
      '</div>' +
      '<div style="font-size:.875rem; line-height:1.6; color:var(--fg-dim);">' +
      '<p style="margin:0 0 .75rem 0;">This app is free, and it stays free. But it is not free to run:</p>' +
      '<ul style="margin:0 0 .75rem 1.25rem; padding:0; display:flex; flex-direction:column; gap:0.4rem;">' +
      '<li><strong>Hosting &amp; infrastructure:</strong> roughly EUR 45-100 every month, rain or shine.</li>' +
      '<li><strong>AI OCR scans:</strong> every screenshot you analyze calls a paid AI API. Costs scale directly with how much the community uses it.</li>' +
      '<li><strong>Development:</strong> hundreds of hours of design, coding, bug fixes, and feature requests handled one by one — evenings and weekends, on top of a day job.</li>' +
      '</ul>' +
      '<p style="margin:0;">Your donation covers the servers, keeps the AI scans flowing, and tells me the time I put into this tool is worth it. Every coffee genuinely helps. Thank you!</p>' +
      '</div>' +
      '</div>'
    );
  }

  private static customAmountCardHtml(): string {
    return (
      '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1.25rem;">' +
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
      '</div>'
    );
  }

  private static async startCheckout(planKey: string, customAmountCents: number | null, triggerBtn: HTMLButtonElement | null): Promise<void> {
    const cfg = SubscriptionView.state.config;
    if (!cfg || !cfg.configured) {
      showToast(t('gm_donate_not_configured') || t('gm_sub_not_configured') || 'Donations are not configured yet.', 'error');
      return;
    }
    if (SubscriptionView.state.busy) return;
    SubscriptionView.state.busy = true;

    let origHtml = '';
    if (triggerBtn) {
      origHtml = triggerBtn.innerHTML;
      triggerBtn.disabled = true;
      triggerBtn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> <span>Redirecting...</span>';
    }

    const guildId = getGuildId();
    const returnUrl = window.location.href.split('?')[0];

    try {
      const data = await SubscriptionService.createDonationCheckout({
        plan: planKey,
        guildId,
        returnUrl,
        amountCents: planKey === 'donation_custom' ? (customAmountCents ?? undefined) : undefined,
      });
      if (!data.ok || !data.url) throw new Error(data.error || 'order_failed');

      SubscriptionView.startCheckoutRedirect(data.url);
    } catch (err: any) {
      SubscriptionView.state.busy = false;
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.innerHTML = origHtml;
      }
      const errCode = (err && err.message) || '';
      if (errCode === 'donations_disabled') {
        showToast(t('gm_donate_disabled_body') || 'Donations are disabled on this guild.', 'info');
      } else if (errCode === 'invalid_amount') {
        showToast(t('gm_donate_invalid_amount') || 'Please enter a valid amount between 2 and 100 EUR.', 'error');
      } else {
        showToast(t('gm_sub_widget_error') || 'Could not start the donation checkout.', 'error');
      }
    }
  }

  private static render(container: HTMLElement): void {
    let html = SubscriptionView.freeAppStatusCardHtml();

    html +=
      '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1.25rem;">' +
      '<div class="gm-dim" style="font-size:.75rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; margin-bottom:.75rem;">' +
      (t('gm_sub_plans_title') || 'Support the Project') +
      '</div>' +
      '<div class="gm-sub-plans-grid">' +
      DONATION_TIERS.map(SubscriptionView.tierCardHtml).join('') +
      '</div>' +
      '</div>';

    html += SubscriptionView.customAmountCardHtml();
    html += SubscriptionView.transparencyCardHtml();

    html +=
      '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1rem;">' +
      '<div class="gm-dim" style="font-size:.82rem; display:flex; align-items:center; gap:0.4rem;">' +
      '<i class="ph ph-shield-check" style="color:var(--accent, #6366f1); font-size:1.1rem;"></i> ' +
      '<span>' + (t('gm_sub_security') || 'All payments are securely processed and managed by Stripe.') +
      ' • <a href="terms.html" style="color:var(--text-muted); text-decoration:underline;">' + (t('footer_terms') || 'Terms & Conditions') + '</a></span>' +
      '</div>' +
      '</div>';

    container.innerHTML = html;

    container.querySelectorAll('[data-gm-sub-plan]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const planKey = btn.getAttribute('data-gm-sub-plan') || '';
        SubscriptionView.startCheckout(planKey, null, btn as HTMLButtonElement);
      });
    });

    const customBtn = document.getElementById('donation-custom-btn');
    const customInput = document.getElementById('donation-custom-input') as HTMLInputElement | null;
    const customErr = document.getElementById('donation-custom-error');
    if (customBtn && customInput) {
      customBtn.addEventListener('click', () => {
        const val = parseFloat(customInput.value);
        if (isNaN(val) || val < 2 || val > 100 || !Number.isInteger(Math.round(val * 100) / 100)) {
          if (customErr) customErr.style.display = 'block';
          return;
        }
        if (customErr) customErr.style.display = 'none';
        const cents = Math.round(val * 100);
        SubscriptionView.startCheckout('donation_custom', cents, customBtn as HTMLButtonElement);
      });
      customInput.addEventListener('input', () => {
        if (customErr) customErr.style.display = 'none';
      });
    }
  }

  public static async handleReturn(container?: HTMLElement | null, search?: string): Promise<void> {
    const params = new URLSearchParams(search === undefined ? window.location.search : search);
    const mode = params.get('checkout');

    if (search === undefined && (mode === 'success' || mode === 'cancel')) {
      try {
        window.history.replaceState({}, '', window.location.pathname + window.location.hash);
      } catch {
        /* non fatal */
      }
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
        const retBtn = document.getElementById('btn-return-donation');
        if (retBtn) retBtn.addEventListener('click', () => SubscriptionView.load());
      }
    }
  }

  public static loadingHtml(): string {
    return (
      '<div class="gm-subscription-skeleton" aria-busy="true" aria-label="Loading donation options">' +
        '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1.25rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap;">' +
          '<div class="gm-skeleton" style="width:48px; height:48px; border-radius:12px; flex-shrink:0;"></div>' +
          '<div style="flex:1; min-width:200px;">' +
            '<div class="gm-skeleton gm-skeleton-title" style="width:180px; height:1.2rem; margin-bottom:0.4rem;"></div>' +
            '<div class="gm-skeleton gm-skeleton-text" style="width:340px; max-width:100%; height:0.85rem;"></div>' +
          '</div>' +
          '<div class="gm-skeleton gm-skeleton-badge" style="width:85px; height:1.6rem;"></div>' +
        '</div>' +
        '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1.25rem;">' +
          '<div class="gm-skeleton gm-skeleton-text" style="width:140px; height:0.9rem; margin-bottom:1rem;"></div>' +
          '<div class="gm-sub-plans-grid">' +
            [1, 2, 3].map(() =>
              '<div class="gm-card gm-skeleton-card" style="padding:1.25rem; min-height:160px; justify-content:space-between;">' +
                '<div>' +
                  '<div class="gm-skeleton" style="width:36px; height:36px; border-radius:8px; margin-bottom:0.6rem;"></div>' +
                  '<div class="gm-skeleton gm-skeleton-title" style="width:90px; height:1.1rem; margin-bottom:0.4rem;"></div>' +
                  '<div class="gm-skeleton gm-skeleton-text" style="width:120px; height:0.8rem;"></div>' +
                '</div>' +
                '<div class="gm-skeleton gm-skeleton-btn" style="width:100%; height:2.2rem; margin-top:1rem;"></div>' +
              '</div>'
            ).join('') +
          '</div>' +
        '</div>' +
        '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1.25rem;">' +
          '<div class="gm-skeleton gm-skeleton-title" style="width:130px; height:1.1rem; margin-bottom:0.5rem;"></div>' +
          '<div class="gm-skeleton gm-skeleton-text" style="width:260px; height:0.85rem; margin-bottom:0.85rem;"></div>' +
          '<div style="display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap; max-width:460px;">' +
            '<div class="gm-skeleton" style="flex:1; min-width:140px; height:2.5rem; border-radius:var(--radius-md);"></div>' +
            '<div class="gm-skeleton gm-skeleton-btn" style="width:110px; height:2.5rem; border-radius:var(--radius-md);"></div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  private static errorHtml(msg: string): string {
    return (
      '<div class="gm-empty">' +
      '<i class="ph-duotone ph-warning-circle gm-icon"></i>' +
      '<div class="gm-empty-title">' + (t('gm_sub_load_error') || 'Could not load the donation page') + '</div>' +
      '<div class="gm-empty-hint">' + esc(msg) + '</div>' +
      '<button class="gm-btn gm-btn-primary" id="subscription-retry" style="margin-top:.5rem;"><i class="ph ph-arrow-clockwise"></i> ' + (t('gm_sub_retry') || 'Retry') + '</button>' +
      '</div>'
    );
  }

  private static deniedHtml(): string {
    return (
      '<div class="gm-empty">' +
      '<i class="ph-duotone ph-shield-warning gm-icon"></i>' +
      '<div class="gm-empty-title">' + (t('gm_sub_denied') || 'Admins only') + '</div>' +
      '</div>'
    );
  }

  private static paymentsDisabledHtml(): string {
    return (
      '<div class="gm-empty">' +
      '<i class="ph-duotone ph-coffee gm-icon"></i>' +
      '<div class="gm-empty-title">' + (t('gm_donate_disabled_title') || 'Donations are disabled') + '</div>' +
      '<div class="gm-empty-hint">' + (t('gm_donate_disabled_body') || 'Donations are disabled on the demonstration server.') + '</div>' +
      '</div>'
    );
  }

  // Test/debug surface, mirrors legacy window.GM_SUBSCRIPTION._plans / _state.
  public static get plans(): DonationTier[] {
    return DONATION_TIERS;
  }

  public static get debugState(): SubscriptionState {
    return SubscriptionView.state;
  }
}

// Self-registers on window.GM_SUBSCRIPTION, same shape as legacy
// subscription.js (load, handleReturn, _plans, _state, _redirectTo) so
// app.js's existing call site (window.GM_SUBSCRIPTION.load() on
// tab-subscription) and tests/subscription.test.js keep working unchanged.
// Mirrors the self-registration pattern in core/i18n/i18n.ts.
if (typeof window !== 'undefined') {
  (window as any).GM_SUBSCRIPTION = {
    load: () => SubscriptionView.load(),
    handleReturn: (container?: HTMLElement | null, search?: string) => SubscriptionView.handleReturn(container, search),
    _plans: SubscriptionView.plans,
    get _state() {
      return SubscriptionView.debugState;
    },
    _redirectTo: SubscriptionView.redirectTo,
  };
}
