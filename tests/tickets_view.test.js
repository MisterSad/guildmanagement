/**
 * tests/tickets_view.test.js
 *
 * Phase 1 behavioural suite for src/modules/tickets/views/TicketsView.ts in
 * jsdom. The legacy root `tickets.js` is untouched during Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TicketsView, loadingHtml } from '../src/modules/tickets/views/TicketsView';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';

// The view imports its collaborators directly; mock the source modules
// rather than a window bridge.
const mocks = vi.hoisted(() => ({ superAdmin: true, showToast: vi.fn() }));

vi.mock('../src/core/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  t: (k) => k
}));
vi.mock('../src/core/auth/roles', async (importOriginal) => ({
  ...(await importOriginal()),
  isSuperAdmin: () => mocks.superAdmin
}));
vi.mock('../src/core/dom/toast', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: mocks.showToast
}));

let invokeMock;

function installClient({ superAdmin = true } = {}) {
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

  mocks.superAdmin = superAdmin;
  // Installed the way main.ts installs the real client (getClient() reads it).
  setDbClient({ functions: { invoke: invokeMock } });
}

function mountContainer() {
  document.body.innerHTML = '<div id="tickets-container"></div>';
  return document.getElementById('tickets-container');
}

afterEach(() => {
  resetSupabaseClient();
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
    installClient();
    const container = mountContainer();
    const view = new TicketsView();
    await view.load();

    expect(invokeMock).toHaveBeenCalledWith('tickets', { body: { action: 'list' } });
    expect(container.querySelector('.gm-ticket-status')).toBeTruthy();
    expect(container.textContent).toContain('#TICKET-0007');
    expect(container.textContent).toContain('Crash');
  });

  it('renders the error screen with a working retry button', async () => {
    installClient();
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
    installClient({ superAdmin: false });
    const container = mountContainer();
    const view = new TicketsView();
    await view.load();
    expect(container.textContent).toContain('Super admin only');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('shows the skeleton when the db client is unavailable', async () => {
    mocks.superAdmin = true;
    resetSupabaseClient();
    const container = mountContainer();
    const view = new TicketsView();
    await view.load();
    expect(container.innerHTML).toContain('gm-tickets-skeleton-list');
  });
});
