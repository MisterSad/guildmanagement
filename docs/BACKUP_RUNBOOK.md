# Database backup runbook

The production project runs on the Supabase **Free plan, which keeps no backups and has no point-in-time recovery** (audit finding INF-01, 2026-10-03). This runbook covers the backup that replaces them.

| | |
|---|---|
| What | `pg_dump` (custom format) of `public`, `auth`, `storage`, `cron`, `supabase_migrations`; `cron.job_run_details` rows excluded |
| When | Every night at 02:17 UTC, plus on demand (*Actions → Database Backup → Run workflow*) |
| Where | GitHub Actions artifact `db-backup-<UTC stamp>` on this private repository, kept **30 days** |
| How it is protected | Encrypted with [age](https://age-encryption.org) to a public key before upload. The private key never touches GitHub. |
| Who connects | `gm_backup`: a login role that can read and cannot write (migration `20261003091725_backup_reader_role.sql`) |
| Workflow | `.github/workflows/db-backup.yml` |

A failed run is a failed backup. GitHub e-mails the repository owner when a scheduled workflow fails. Do not ignore those e-mails.

## What is *not* in the backup

Keep these somewhere safe yourself. Without them, a restore is incomplete.

- **Vault secrets**, above all `gm_accounts_key`. `accounts.password_enc` and `accounts.gotrue_secret_enc` are encrypted with it. Vault is encrypted with a key tied to this Supabase project, so dumping it would be useless elsewhere.
- **Edge Function secrets** (Discord, Gemini, `CRON_SECRET`, …) and the Vercel and Render environment variables.
- **Storage file contents.** Only object metadata is dumped. The one bucket in use, `ocr-videos`, holds transient uploads that are deleted after each scan.
- **The age private key.** If it is lost, every backup is unreadable.

## One-time setup (owner)

The workflow fails with an explicit error until these three steps are done.

**1. Create the encryption key pair** on your own machine, never on a server:

```bash
age-keygen -o ~/gm-backup-key.txt
```

The command prints the public key (`age1…`). Keep `~/gm-backup-key.txt` offline, in a password manager and in a second place. It is the only way to read a backup.

**2. Give `gm_backup` a password.** Run this in the Supabase dashboard SQL editor, with a long random value (for example the output of `openssl rand -base64 32`):

```sql
ALTER ROLE gm_backup WITH PASSWORD '<long random value>';
```

**3. Store the connection details in GitHub** (*Settings → Secrets and variables → Actions*):

- Secret `BACKUP_DATABASE_URL`: the **Session pooler** connection string from *Dashboard → Connect*, with the user and password replaced. GitHub runners have no IPv6, so the direct connection does not work.
  `postgresql://gm_backup.vgweufzwmfwplusskmuf:<password>@<session-pooler-host>:5432/postgres`
- Variable `BACKUP_AGE_RECIPIENT`: the `age1…` public key from step 1. It is public and does not need to be a secret.

Then run the workflow once by hand and check that its summary lists the dump size and the number of tables.

## Restoring

### 1. Fetch and decrypt

```bash
gh run list --workflow=db-backup.yml --limit 5
gh run download <run-id> --dir ./restore
age --decrypt -i ~/gm-backup-key.txt -o ./restore/gm.dump ./restore/db-backup-*/gm-*.dump.age
pg_restore --list ./restore/gm.dump | less
```

`*.dump`, `*.dump.age` and `restore/` are git-ignored. Delete the decrypted file when you are done: it contains every account and every player.

### 2. Restore a few rows (accidental deletion)

This is the common case: a bad `DELETE` on one table, with the rest of the database fine.

1. Extract the table into a scratch schema.
2. Inspect it.
3. Copy back only the rows that are missing.

```bash
pg_restore --data-only --table=<table> -f ./restore/<table>.sql ./restore/gm.dump
```

Edit the `COPY` target in that file to `restore_scratch.<table>`. Create that table with `CREATE TABLE restore_scratch.<table> (LIKE public.<table>)`, load the file, then `INSERT … SELECT … WHERE NOT EXISTS (…)`. Wrap the copy-back in `BEGIN … ROLLBACK` first, and commit only once the counts are right.

### 3. Rebuild a whole project

This is for the case where the project itself is lost. The target is a new Supabase project, so the Supabase roles (`anon`, `authenticated`, `service_role`, …) and extensions already exist.

```bash
NEW="postgresql://postgres:<password>@<new-session-pooler-host>:5432/postgres"
# Schema, then data, with triggers off while rows go in.
pg_restore --schema-only --no-owner --schema=public -d "$NEW" ./restore/gm.dump
PGOPTIONS='-c session_replication_role=replica' \
  pg_restore --data-only --no-owner \
    --schema=public --schema=auth --schema=storage --schema=supabase_migrations \
    -d "$NEW" ./restore/gm.dump
```

Then:

1. Recreate the Vault secrets, with the **same** `gm_accounts_key`.
2. Set the Edge Function secrets and deploy the 14 functions.
3. Recreate the cron jobs from `cron.job` in the dump.
4. Point Vercel and the Render worker at the new project.

> **Not yet rehearsed.** The procedure above has not been run end to end. Rehearse it once against a scratch project, then replace this note with the date and the row counts you compared.

## Rotating

- **Database password**: run `ALTER ROLE gm_backup WITH PASSWORD '…'`, then update `BACKUP_DATABASE_URL`.
- **age key**: generate a new pair, then update `BACKUP_AGE_RECIPIENT`. Keep the old private key until the last backup encrypted with it has expired, which takes 30 days.
