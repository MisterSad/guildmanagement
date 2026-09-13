/**
 * tests/tickets_view.test.js
 *
 * Phase 1 behavioural suite for src/modules/tickets/views/TicketsView.ts in
 * jsdom. The legacy root `tickets.js` is untouched during Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TicketsView, loadingHtml } from '../src/modules/tickets/views/TicketsView';

let invokeMock;

function installGM({ superAdmin = true } = {}) {
  invokeMock = vi.fn(async (_fn, opts) => {
    const action = opts && opts.body ? opts.body.action : undefined;
    if (action === 'list') {
      return {
        data: {
          ok: true,
          tickets: [
            { id: 7, ticket_number: 7, status: 'open', severity: 'high', category: 'bug', title: 'Crash', description: 'It broke', reporter_account_id: 'Alpha', reporter_role: 'R4', guild: 'ALPHA', created_at: '2026-08-01T10:00:00Z', attachments: [] }
          ]
        },
        error: null
      };
    }
    return { data: { ok: true }, error: null };
  });

  window.GM = {
    t: (k) => k,
    escapeHTML: (s) => String(s ?? ''),
    formatNumber: (n) => String(n ?? ''),
    isSuperAdmin: () => superAdmin,
    showToast: vi.fn(),
    db: { functions: { invoke: invokeMock } }
  };
}

function mountContainer() {
  document.body.innerHTML = '<div id="tickets-container"></div>';
  return document.getElementById('tickets-container');
}

afterEach(() => {
  delete window.GM;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('loadingHtml() module export', () => {
  it('returns the skeleton list wrapper with 4 skeleton cards', () => {
    const html = loadingHtml();
    expect(html).toContain('gm-tickets-skeleton-list');
    expect(html).toContain('aria-busy="true"');
    const cards = (html.match(/gm-skeleton-card/g) || []).length;
    expect(cards).toBe(4);
    expect(new TicketsView().loadingHtml()).toBe(html);
  });
});

describe('TicketsView.load()', () => {
  it('renders the ticket table on success', async () => {
    installGM();
    const container = mountContainer();
    const view = new TicketsView();
    await view.load();

    expect(invokeMock).toHaveBeenCalledWith('tickets', { body: { action: 'list' } });
    expect(container.querySelector('.gm-ticket-status')).toBeTruthy();
    expect(container.textContent).toContain('#TICKET-0007');
    expect(container.textContent).toContain('Crash');
  });

  it('renders the error screen with a working retry button', async () => {
    installGM();
    invokeMock.mockImplementation(async () => ({ data: { ok: false, error: 'list_failed' }, error: null }));
    const container = mountContainer();
    const view = new TicketsView();
    await view.load();

    expect(container.textContent).toContain('Could not load tickets');
    const retry = container.querySelector('[data-tickets-retry]');
    expect(retry).toBeTruthy();

    retry.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('renders the super-admin gate for non super admins', async () => {
    installGM({ superAdmin: false });
    const container = mountContainer();
    const view = new TicketsView();
    await view.load();
    expect(container.textContent).toContain('Super admin only');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('shows the skeleton when the db client is unavailable', async () => {
    window.GM = { t: (k) => k, escapeHTML: (s) => String(s ?? ''), db: null };
    const container = mountContainer();
    const view = new TicketsView();
    await view.load();
    expect(container.innerHTML).toContain('gm-tickets-skeleton-list');
  });
});
