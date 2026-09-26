/**
 * supabase/functions/_shared/backup-codes.ts
 *
 * Backup codes: generation, normalisation, hashing and single-use redemption.
 *
 * Extracted verbatim from auth-passkey during phase D6 so that function and
 * auth-discord share ONE implementation. The audit's M11 finding was that this
 * codebase had four subtly different HTML-escaping routines; a credential
 * check is a far worse place for the same drift, and during the transition both
 * endpoints must accept exactly the same codes.
 *
 * WHO GETS BACKUP CODES AFTER THE DISCORD MIGRATION
 * Only the `super_admin`. Every other account has an administrator above it who
 * can unlink and reissue a relink code, which is a stronger recovery path
 * because it involves a second human. For those accounts a backup code would
 * just be a weaker second credential sitting next to the strong one. The
 * super_admin has nobody above them, so they need codes -- that is the whole
 * asymmetry, and it is why the issuing action in auth-discord is role-gated.
 *
 * The plaintext is returned exactly once, at issue time. Only the SHA-256 hash
 * is ever stored.
 */

/** Ten codes per set; regenerating always replaces the whole set. */
export const BACKUP_CODE_COUNT = 10;

/**
 * Excludes visually ambiguous characters: no 0/O, no 1/I/L. These are read
 * aloud, written down and retyped under stress, so the alphabet matters.
 */
export const BACKUP_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** `XXXXX-XXXXX`, eleven characters including the dash. */
export const BACKUP_CODE_LENGTH = 11;

export function randomBackupCode(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (const b of bytes) raw += BACKUP_CODE_ALPHABET[b % BACKUP_CODE_ALPHABET.length];
  return raw.slice(0, 5) + "-" + raw.slice(5, 10);
}

/**
 * Accepts whatever the user typed and returns the canonical form.
 *
 * Case, spaces and stray punctuation are all forgiven, because the alternative
 * is a person who holds a valid code being told it is wrong. Anything that is
 * not exactly ten alphanumerics is returned as-is so the caller's length check
 * rejects it.
 */
export function normalizeBackupCode(raw: string): string {
  const alnum = (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (alnum.length !== 10) return alnum;
  return alnum.slice(0, 5) + "-" + alnum.slice(5, 10);
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Replaces an account's entire backup-code set with a fresh one.
 *
 * One shared set per account: regenerating always invalidates the prior set, so
 * a code someone wrote down last year cannot outlive a reissue. Codes are
 * returned in plaintext exactly once; only their SHA-256 hash is stored.
 */
export async function issueBackupCodes(
  // deno-lint-ignore no-explicit-any
  admin: any,
  accountId: string
): Promise<string[]> {
  await admin.from("account_backup_codes").delete().eq("account_id", accountId);

  for (let attempt = 0; attempt < 3; attempt++) {
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, randomBackupCode);
    const rows = await Promise.all(
      codes.map(async (code) => ({ account_id: accountId, code_hash: await sha256Hex(code) }))
    );
    const { error } = await admin.from("account_backup_codes").insert(rows);
    if (!error) return codes;
    if (error.code !== "23505") throw error; // only retry on a hash collision
  }
  throw new Error("backup_code_generation_failed");
}

export type BackupCodeResult =
  | { ok: true; remaining: number }
  | { ok: false; error: "invalid_code" | "server_error" };

/**
 * Verifies a backup code for `accountId` and consumes it.
 *
 * Marking the row used is what makes a code single-use, and it happens before
 * the caller mints anything, so a failure after this point costs the code
 * rather than leaving it live.
 */
export async function verifyAndConsumeBackupCode(
  // deno-lint-ignore no-explicit-any
  admin: any,
  accountId: string,
  rawCode: string
): Promise<BackupCodeResult> {
  const code = normalizeBackupCode(rawCode);
  if (!code || code.length !== BACKUP_CODE_LENGTH) return { ok: false, error: "invalid_code" };

  const codeHash = await sha256Hex(code);
  const { data: codeRow, error: codeErr } = await admin
    .from("account_backup_codes")
    .select("id")
    .eq("account_id", accountId)
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .maybeSingle();
  if (codeErr) return { ok: false, error: "server_error" };
  if (!codeRow) return { ok: false, error: "invalid_code" };

  await admin
    .from("account_backup_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("id", codeRow.id);

  const { count } = await admin
    .from("account_backup_codes")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .is("used_at", null);

  return { ok: true, remaining: count ?? 0 };
}
