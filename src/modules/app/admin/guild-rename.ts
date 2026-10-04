/**
 * src/modules/app/admin/guild-rename.ts
 *
 * Changing a guild's TAG after creation (gm_rename_guild, migration
 * 20261003070904, ADR-022). The tag is the tenant key, so the server moves every row in
 * one transaction; this module is the UI around it:
 *
 *   - the "Guild TAG" card on Accounts & Access (shown when the server says
 *     the caller may rename: guild_admin of the guild, or super_admin);
 *   - the rename dialog, shared with the super-admin guild list;
 *   - carrying this browser's own state over to the new tag afterwards.
 *
 * The server is the authority on every rule (who, format, cooldown, reserved
 * tags). The client repeats the format check only to answer instantly; it never
 * decides on its own that a rename is allowed.
 */


import { adoptDialog } from '../../../components/ui/Dialog';
import { esc, byId, getDb, ls } from './utils';
import { getActiveGuild } from '../../../core/auth/roles';
import { getAppState, patchAppState } from '../../../core/state/app-state';
import { showToast } from '../dialogs/dialogs.service';

/** Same shape as guild creation and as the server check. */
export const TAG_PATTERN = /^[A-Z0-9_]{2,12}$/;

export interface RenameResult {
  ok: boolean;
  error?: string;
  guild?: string;
  oldGuild?: string;
  nextAllowedAt?: string | null;
}

export interface TagHistoryEntry {
  old_tag: string;
  new_tag: string;
  changed_at: string;
}

export interface TagHistory {
  ok: boolean;
  history: TagHistoryEntry[];
  nextAllowedAt: string | null;
  /** Server-stated: super_admin, or guild_admin of this guild. */
  canRename: boolean;
  /** False for the super_admin, who is exempt from the 7-day cooldown. */
  cooldownApplies: boolean;
}

/** Uppercases and strips the brackets people type around a tag ("[ab]" -> "AB"). */
export function normalizeTag(raw: unknown): string {
  return String(raw ?? '').trim().replace(/^\[+|\]+$/g, '').trim().toUpperCase();
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Human message for each error code gm_rename_guild can return. */
export function renameErrorMessage(code: string | undefined, nextAllowedAt?: string | null): string {
  switch (code) {
    case 'invalid_tag':
      return 'A TAG is 2 to 12 characters: letters, digits or underscore.';
    case 'unchanged':
      return 'That is already the guild\'s TAG.';
    case 'tag_taken':
      return 'Another guild already uses this TAG.';
    case 'tag_reserved':
      return 'This TAG is reserved or still holds data from a former guild. Pick another one, or ask the super admin.';
    case 'demo_protected':
      return 'The DEMO guild cannot be renamed.';
    case 'cooldown': {
      const when = formatDate(nextAllowedAt);
      return 'The TAG was changed less than 7 days ago.' + (when ? ' Next change possible on ' + when + '.' : '');
    }
    case 'unauthorized':
      return 'Only the guild\'s admin or the super admin can change its TAG.';
    case 'guild_not_found':
      return 'This guild no longer exists. Reload the page.';
    default:
      return 'The TAG could not be changed (' + (code || 'unknown error') + ').';
  }
}

/**
 * Moves this browser's tag-keyed localStorage entries to the new tag, and
 * returns how many it moved.
 *
 * `gm_config_<TAG>_<key>` is ambiguous on its own, because a tag may contain an
 * underscore: the entries of guild `AB_C` also start with `gm_config_AB_`. Config
 * keys are lowercase and tags are uppercase, so a key of guild `AB` is
 * `gm_config_AB_` followed by a LOWERCASE letter -- that is what is matched.
 */
export function migrateLocalGuildKeys(store: Storage | null, oldTag: string, newTag: string): number {
  if (!store || !oldTag || !newTag || oldTag === newTag) return 0;
  const moves: Array<[string, string]> = [];
  const configPrefix = 'gm_config_' + oldTag + '_';
  const exact = ['gm_server_number_', 'gm_join_code_plain_'];

  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key) continue;
    if (key.startsWith(configPrefix) && /^[a-z]/.test(key.slice(configPrefix.length))) {
      moves.push([key, 'gm_config_' + newTag + '_' + key.slice(configPrefix.length)]);
      continue;
    }
    for (const prefix of exact) {
      if (key === prefix + oldTag) moves.push([key, prefix + newTag]);
    }
  }

  for (const [from, to] of moves) {
    const value = store.getItem(from);
    if (value !== null) store.setItem(to, value);
    store.removeItem(from);
  }

  for (const pointer of ['gm_current_guild', 'gm_guild_restriction']) {
    if (store.getItem(pointer) === oldTag) store.setItem(pointer, newTag);
  }
  return moves.length;
}

export async function renameGuild(oldTag: string, newTag: string): Promise<RenameResult> {
  const db = getDb();
  if (!db) return { ok: false, error: 'unavailable' };
  const res = await db.rpc('gm_rename_guild', { p_guild: oldTag, p_new_tag: newTag });
  if (res.error) return { ok: false, error: res.error.message || 'request_failed' };
  const data = res.data || {};
  return {
    ok: data.ok === true,
    error: data.error,
    guild: data.guild,
    oldGuild: data.old_guild,
    nextAllowedAt: data.next_allowed_at ?? null,
  };
}

export async function fetchTagHistory(guild: string): Promise<TagHistory> {
  const db = getDb();
  if (!db) return { ok: false, history: [], nextAllowedAt: null, canRename: false, cooldownApplies: true };
  const res = await db.rpc('gm_guild_tag_history', { p_guild: guild });
  const data = (!res.error && res.data) || {};
  return {
    ok: data.ok === true,
    history: Array.isArray(data.history) ? data.history : [],
    nextAllowedAt: data.next_allowed_at ?? null,
    canRename: data.can_rename === true,
    cooldownApplies: data.cooldown_applies !== false,
  };
}

/**
 * Carries the active session over to the new tag, then reloads. A reload is the
 * one place every module re-resolves its tenant, its caches and its realtime
 * subscriptions from scratch; patching each of them in place would miss one.
 */
export function applyRenameToSession(oldTag: string, newTag: string, reload: () => void = () => window.location.reload()): void {
  migrateLocalGuildKeys(ls(), oldTag, newTag);
  const st = getAppState();
  patchAppState({
    currentGuild: st.currentGuild === oldTag ? newTag : st.currentGuild,
    currentGuildRestriction: st.currentGuildRestriction === oldTag ? newTag : st.currentGuildRestriction,
  });
  reload();
}

// ── Dialog ───────────────────────────────────────────────────────────────────

/**
 * Opens the rename dialog for `guild`. `onRenamed` runs after a successful
 * rename of a guild that is NOT the active one (super admin, guild list); the
 * active guild instead goes through applyRenameToSession.
 */
export function openRenameGuildDialog(guild: string, onRenamed?: (newTag: string) => void): void {
  if (typeof document === 'undefined' || !guild) return;

  const existing = document.getElementById('guild-rename-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'guild-rename-overlay';
  overlay.className = 'gm-modal-overlay';
  overlay.style.zIndex = '1000001';
  overlay.innerHTML =
    '<div class="gm-modal-card" style="max-width: 440px; width: 92%;">' +
      '<h3 id="guild-rename-title"><i class="ph ph-tag" aria-hidden="true"></i> Change the TAG of ' + esc(guild) + '</h3>' +
      '<label class="gm-dim" for="guild-rename-input" style="font-size: 0.85rem;">New TAG</label>' +
      '<span class="gm-ui-input gm-ui-input-md" style="margin: 0.35rem 0 0.25rem;">' +
        '<input type="text" id="guild-rename-input" class="gm-ui-input-field" maxlength="14" autocomplete="off" spellcheck="false" ' +
        'style="font-weight: 700; text-transform: uppercase;" placeholder="e.g. PR1M">' +
      '</span>' +
      '<div id="guild-rename-error" class="text-error" role="alert" style="min-height: 1.2em; font-size: 0.85rem;"></div>' +
      '<ul class="gm-dim" style="font-size: 0.85rem; margin: 0.5rem 0 1rem; padding-left: 1.1rem; text-align: left;">' +
        '<li>Every member, score, event and setting moves to the new TAG.</li>' +
        '<li>Other admins signed in right now will need to reload the page.</li>' +
        '<li>Discord roles and channels named after the old TAG are not renamed: rename your guild role in Discord, the bot finds it by name.</li>' +
        '<li>Discord verification picks up the new TAG within 5 minutes.</li>' +
        '<li>A guild admin can change the TAG once every 7 days.</li>' +
      '</ul>' +
      '<div class="confirm-actions">' +
        '<button type="button" id="guild-rename-cancel" class="gm-btn gm-btn-ghost">Cancel</button>' +
        '<button type="button" id="guild-rename-ok" class="gm-btn gm-btn-primary" disabled>Change TAG</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => { overlay.classList.add('visible'); });

  const input = document.getElementById('guild-rename-input') as HTMLInputElement;
  const errorEl = document.getElementById('guild-rename-error') as HTMLElement;
  const okBtn = document.getElementById('guild-rename-ok') as HTMLButtonElement;
  const cancelBtn = document.getElementById('guild-rename-cancel') as HTMLButtonElement;
  let busy = false;

  function close(): void {
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.remove(); }, 300);
  }

  function validate(): string {
    const tag = normalizeTag(input.value);
    let message = '';
    if (tag && !TAG_PATTERN.test(tag)) message = renameErrorMessage('invalid_tag');
    else if (tag === guild) message = renameErrorMessage('unchanged');
    errorEl.textContent = message;
    okBtn.disabled = busy || !tag || message !== '';
    return message ? '' : tag;
  }

  async function submit(): Promise<void> {
    const tag = validate();
    if (!tag || busy) return;
    busy = true;
    okBtn.disabled = true;
    okBtn.textContent = '...';
    try {
      const res = await renameGuild(guild, tag);
      if (!res.ok) {
        errorEl.textContent = renameErrorMessage(res.error, res.nextAllowedAt);
        return;
      }
      const newTag = res.guild || tag;
      close();
      if (getActiveGuild() === guild) {
        showToast('Guild TAG changed to ' + newTag + '. Reloading…', 'success');
        setTimeout(() => applyRenameToSession(guild, newTag), 900);
      } else {
        migrateLocalGuildKeys(ls(), guild, newTag);
        showToast('Guild ' + guild + ' is now ' + newTag + '.', 'success');
        if (onRenamed) onRenamed(newTag);
      }
    } catch (err: any) {
      errorEl.textContent = renameErrorMessage(err && err.message);
    } finally {
      // Re-enable the button without re-running validate(): that would clear
      // the server's refusal from the error line the moment it was written.
      busy = false;
      okBtn.textContent = 'Change TAG';
      okBtn.disabled = !normalizeTag(input.value);
    }
  }

  input.addEventListener('input', () => { validate(); });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); void submit(); } });
  okBtn.addEventListener('click', () => { void submit(); });
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  // Role, label, focus trap and Escape (M5); focus starts in the TAG field.
  adoptDialog(overlay, { labelledBy: 'guild-rename-title', onEscape: close, initialFocus: input });
}

// ── Card (Accounts & Access) ─────────────────────────────────────────────────

/**
 * Shows the "Guild TAG" card to whoever the server says may rename: the
 * super_admin, or a guild_admin of the active guild. A server_admin can read the
 * history but not rename, so the card stays hidden for them rather than
 * offering a button that always fails. The client never decides this itself.
 */
export async function loadGuildTagCard(): Promise<void> {
  const card = byId('guild-tag-card');
  if (!card) return;
  const guild = getActiveGuild();
  if (!guild) {
    card.classList.add('hidden');
    return;
  }

  const currentEl = byId('guild-tag-current');
  const infoEl = byId('guild-tag-info');
  const historyEl = byId('guild-tag-history');
  const btn = byId<HTMLButtonElement>('guild-tag-rename-btn');
  if (currentEl) currentEl.textContent = guild;

  const hist = await fetchTagHistory(guild);
  if (!hist.ok || !hist.canRename) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  const cooling = hist.cooldownApplies && hist.nextAllowedAt && new Date(hist.nextAllowedAt).getTime() > Date.now();
  if (btn) btn.disabled = Boolean(cooling);
  if (infoEl) {
    infoEl.textContent = cooling
      ? 'Next change possible on ' + formatDate(hist.nextAllowedAt) + '.'
      : 'You can change the TAG once every 7 days.';
  }
  if (historyEl) {
    historyEl.innerHTML = hist.history.map((h) =>
      '<li>' + esc(h.old_tag) + ' → <strong>' + esc(h.new_tag) + '</strong> <span class="gm-dim">· ' + esc(formatDate(h.changed_at)) + '</span></li>'
    ).join('');
    historyEl.classList.toggle('hidden', hist.history.length === 0);
  }

  if (btn && !(btn as any).__gmAdminWired) {
    (btn as any).__gmAdminWired = true;
    btn.addEventListener('click', () => {
      const active = getActiveGuild();
      if (active) openRenameGuildDialog(active, () => { void loadGuildTagCard(); });
    });
  }
}
