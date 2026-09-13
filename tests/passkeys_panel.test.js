/**
 * tests/passkeys_panel.test.js
 *
 * Phase 1 behavioural suite for src/modules/auth/PasskeysPanel.ts in jsdom.
 * The legacy root `gm-webauthn.js` is untouched during Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountPasskeysPanel, downloadBackupCodes, formatPasskeyDate } from '../src/modules/auth/PasskeysPanel';

let invokeMock;
let showConfirmMock;

function installGM() {
  invokeMock = vi.fn(async (_fn, opts) => {
    const action = opts.body.action;
    if (action === 'list') {
      return { data: { ok: true, passkeys: [{ id: 'p1', device_label: 'My Mac', created_at: '2026-01-01T00:00:00Z', last_used_at: null }], backupCodesRemaining: 2 }, error: null };
    }
    if (action === 'regenerate-backup-codes') {
      return { data: { ok: true, backupCodes: ['AAAA-1111', 'BBBB-2222'] }, error: null };
    }
    return { data: { ok: true }, error: null };
  });
  showConfirmMock = vi.fn((title, html, cb) => { cb && cb(); });
  window.showConfirm = showConfirmMock;
  window.GM = {
    db: { functions: { invoke: invokeMock } },
    parseFunctionsInvokeResult: (r) => (r && r.data) || { ok: false, error: 'request_failed' },
    escapeHTML: (s) => String(s ?? ''),
    showToast: vi.fn(),
    currentAccountId: 'acc-1'
  };
  window.requestAnimationFrame = (cb) => { cb(0); return 0; };
}

function mount() {
  document.body.innerHTML =
    '<div id="list"></div>' +
    '<button id="add"></button>' +
    '<button id="regen" class="hidden"></button>' +
    '<span id="regen-label"></span>';
}

function panel() {
  return mountPasskeysPanel({
    listEl: document.getElementById('list'),
    addBtnEl: document.getElementById('add'),
    regenBtnEl: document.getElementById('regen'),
    regenLabelEl: document.getElementById('regen-label')
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mount();
  installGM();
});

afterEach(() => {
  delete window.GM;
  delete window.showConfirm;
  delete window.requestAnimationFrame;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('PasskeysPanel — rendering', () => {
  it('lists passkeys and shows the backup-codes remaining label', async () => {
    const handle = panel();
    await handle.reload();

    expect(document.querySelectorAll('#list .gm-cred-card').length).toBe(1);
    expect(document.getElementById('list').textContent).toContain('My Mac');
    expect(document.getElementById('regen').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('regen-label').textContent).toBe('Regenerate Backup Codes (2 left)');
  });

  it('shows the empty state when no passkeys exist', async () => {
    invokeMock.mockImplementation(async (_fn, opts) => {
      if (opts.body.action === 'list') return { data: { ok: true, passkeys: [], backupCodesRemaining: 0 }, error: null };
      return { data: { ok: true }, error: null };
    });
    const handle = panel();
    await handle.reload();
    expect(document.getElementById('list').textContent).toContain('No passkeys yet');
    expect(document.getElementById('regen').classList.contains('hidden')).toBe(true);
  });

  it('formats passkey dates', () => {
    expect(formatPasskeyDate(null)).toBe('-');
    expect(formatPasskeyDate('not-a-date')).toBe('-');
    expect(formatPasskeyDate('2026-01-02T00:00:00Z')).toBe('02/01/2026');
  });
});

describe('PasskeysPanel — rename & remove', () => {
  it('renames a passkey via the inline input (Enter commits)', async () => {
    const handle = panel();
    await handle.reload();

    document.querySelector('.gm-passkey-rename').click();
    const input = document.querySelector('.gm-passkey-label-wrap input');
    expect(input).toBeTruthy();
    input.value = 'Renamed key';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();

    const call = invokeMock.mock.calls.find((c) => c[1].body.action === 'rename');
    expect(call).toBeTruthy();
    expect(call[1].body.payload).toEqual({ id: 'p1', device_label: 'Renamed key' });
  });

  it('removes a passkey after confirmation', async () => {
    const handle = panel();
    await handle.reload();

    document.querySelector('.gm-passkey-remove').click();
    await tick();

    expect(showConfirmMock).toHaveBeenCalledWith('Remove Passkey', expect.any(String), expect.any(Function));
    const call = invokeMock.mock.calls.find((c) => c[1].body.action === 'remove');
    expect(call[1].body.payload).toEqual({ id: 'p1' });
  });
});

describe('PasskeysPanel — backup codes', () => {
  it('regenerates backup codes and shows the one-time dialog', async () => {
    const handle = panel();
    await handle.reload();

    document.getElementById('regen').click();
    await tick();

    const call = invokeMock.mock.calls.find((c) => c[1].body.action === 'regenerate-backup-codes');
    expect(call).toBeTruthy();
    const overlay = document.getElementById('backup-codes-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain('AAAA-1111');
    expect(document.getElementById('backup-codes-download')).toBeTruthy();
  });

  it('downloads backup codes as a text file (Blob + object URL)', () => {
    vi.useFakeTimers();
    const createSpy = vi.fn(() => 'blob:mock');
    const revokeSpy = vi.fn();
    window.URL.createObjectURL = createSpy;
    window.URL.revokeObjectURL = revokeSpy;

    downloadBackupCodes(['AAAA-1111', 'BBBB-2222'], 'acc-1');

    expect(createSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock');
    vi.useRealTimers();
  });
});

describe('PasskeysPanel — cutover guard', () => {
  it('does not expose window.GM.webauthn', async () => {
    const handle = panel();
    await handle.reload();
    expect(window.GM.webauthn).toBeUndefined();
  });
});
