/**
 * src/modules/app/admin-loader.ts
 *
 * The one way into the admin chunk (admin-shell.ts). Kept apart from it so
 * that importing the loader never pulls the admin code into the entry bundle.
 */

type AdminShell = typeof import('./admin-shell');

let pending: Promise<AdminShell> | null = null;

/** Imports the admin chunk once and wires it; every call resolves to the same module. */
export function loadAdmin(): Promise<AdminShell> {
  if (!pending) {
    pending = import('./admin-shell').then((admin) => { admin.startAdmin(); return admin; });
    // A failed download must not poison later attempts.
    pending.catch(() => { pending = null; });
  }
  return pending;
}
