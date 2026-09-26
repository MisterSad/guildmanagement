/**
 * src/modules/app/auth/portal.controller.ts
 *
 * Sous-lot 6.3 (Strangler) — standalone Player Submission Portal post-login
 * step ported from app.js#handlePortalLookupSuccess. Marks the session as a
 * portal session, verifies it through the JWT-gated `member-portal` Edge
 * Function, then reveals the portal dashboard.
 *
 * Runtime note: this module owns the behaviour and is exposed on
 * `window.GM_AUTH`. The click wiring used to belong to `app.js`, which no longer
 * exists.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { LoginResponse } from './auth.controller';

function w(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function el(id: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id);
}

function setPortalError(message: string): void {
  const box = el('portal-lookup-error');
  if (!box) return;
  const span = box.querySelector('span');
  if (span) span.textContent = message;
  box.classList.remove('hidden');
}

/** Shared post-login step for the standalone Player Submission Portal entry. */
export async function handlePortalLookupSuccess(loginResp: LoginResponse, typedId: string): Promise<void> {
  const id = loginResp.id || typedId;

  try {
    localStorage.setItem('gm_portal_session', '1');
    localStorage.setItem('gm_role', 'member');
    localStorage.setItem('gm_user', id);
  } catch (_) { /* storage unavailable */ }

  const g = w().GM;
  const client = g && g.db ? g.db : null;
  if (!client) {
    setPortalError('Unable to connect to the portal. Please try again.');
    return;
  }

  const { data, error } = await client.functions.invoke('member-portal', {
    body: { action: 'get-active-sessions', payload: {} }
  });

  if (error || !data || !data.ok) {
    setPortalError('Unable to connect to the portal. Please try again.');
    return;
  }

  if (data.error === 'player_not_found') {
    setPortalError('Your account is not linked to a guild member.');
    return;
  }

  const loginView = el('login-view');
  const dashboardView = el('dashboard-view');
  if (loginView) loginView.classList.add('hidden');
  if (dashboardView) { dashboardView.classList.add('hidden'); dashboardView.classList.remove('active'); }

  const stepLookup = el('portal-step-lookup');
  const stepForm = el('portal-step-form');
  const portalView = el('player-portal-view');
  if (portalView) portalView.classList.remove('hidden');
  if (stepLookup) stepLookup.classList.add('hidden');
  if (stepForm) stepForm.classList.remove('hidden');
  if (portalView) portalView.classList.add('portal-connected');

  const container = document.querySelector('.gm-portal-container');
  if (container) container.classList.add('portal-wide');

  const portal = w().GM_PORTAL;
  if (portal && typeof portal.loadDashboard === 'function') {
    portal.loadDashboard();
  } else {
    setPortalError('Portal module not loaded. Please reload the page.');
  }
}
