// Guards the nightly database backup (audit finding INF-01: the Supabase Free
// plan keeps no backups). What must never regress:
//   - only an encrypted file leaves the runner;
//   - the dump is checked before it counts as a backup;
//   - the connecting role can read everything and write nothing;
//   - no password is ever checked in.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

const workflow = read('.github/workflows/db-backup.yml');
const migration = read('supabase/migrations/20261003091725_backup_reader_role.sql');

describe('db-backup workflow', () => {
  it('runs nightly and on demand, with read-only repository permissions', () => {
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron: '17 2 \* \* \*'/);
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toMatch(/permissions:\s*\n\s*contents: read/);
  });

  it('takes its credentials from a secret, its key from a variable, never inline', () => {
    expect(workflow).toContain('${{ secrets.BACKUP_DATABASE_URL }}');
    expect(workflow).toContain('${{ vars.BACKUP_AGE_RECIPIENT }}');
    expect(workflow).not.toMatch(/postgresql:\/\//);
    // Secrets reach shell steps through env, never interpolated into a script.
    const lines = workflow.split('\n');
    const scripts = [];
    lines.forEach((line, i) => {
      const m = line.match(/^(\s*)run: \|\s*$/);
      if (!m) return;
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        const indent = lines[j].match(/^\s*/)[0].length;
        if (lines[j].trim() && indent <= m[1].length) break;
        body.push(lines[j]);
      }
      scripts.push(body.join('\n'));
    });
    expect(scripts.length).toBe(3);
    for (const s of scripts) expect(s).not.toMatch(/\$\{\{/);
  });

  it('dumps the application schemas and drops only the cron log rows', () => {
    for (const schema of ['public', 'auth', 'storage', 'cron', 'supabase_migrations']) {
      expect(workflow).toContain(`--schema=${schema}`);
    }
    expect(workflow).toContain("--exclude-table-data='cron.job_run_details'");
    expect(workflow).toContain('--format=custom');
  });

  it('fails when the dump is unreadable or misses the core tables', () => {
    expect(workflow).toContain('pg_restore --list "$DUMP"');
    for (const t of ['public accounts', 'public guild_members', 'auth users']) {
      expect(workflow).toContain(`"${t}"`);
    }
    expect(workflow).toMatch(/\[ "\$SIZE" -gt 1000000 \]/);
  });

  it('uploads only the age-encrypted file, after shredding the plaintext', () => {
    const encrypt = workflow.indexOf('age --encrypt --recipient "$AGE_RECIPIENT"');
    const shred = workflow.indexOf('shred -u "$DUMP"');
    const upload = workflow.indexOf('uses: actions/upload-artifact@v4');
    expect(encrypt).toBeGreaterThan(-1);
    expect(shred).toBeGreaterThan(encrypt);
    expect(upload).toBeGreaterThan(shred);
    // The plaintext is written outside the uploaded directory.
    expect(workflow).toContain('DUMP="$RUNNER_TEMP/gm-$STAMP.dump"');
    expect(workflow).toContain('path: ${{ runner.temp }}/out/');
    expect(workflow).toContain('retention-days: 30');
    expect(workflow).toContain('if-no-files-found: error');
  });
});

describe('gm_backup role', () => {
  it('can read everything, including through RLS', () => {
    expect(migration).toMatch(/CREATE ROLE gm_backup WITH LOGIN[\s\S]*BYPASSRLS/);
    expect(migration).toContain('GRANT pg_read_all_data TO gm_backup;');
    expect(migration).toContain('ALTER ROLE gm_backup SET default_transaction_read_only = on;');
  });

  it('holds no administrative attribute, and asserts it cannot write', () => {
    expect(migration).toMatch(/NOSUPERUSER NOCREATEDB NOCREATEROLE/);
    expect(migration).not.toMatch(/pg_write_all_data TO/);
    expect(migration).toMatch(/pg_has_role\('gm_backup', 'pg_write_all_data', 'USAGE'\)/);
  });

  it('never carries a password', () => {
    expect(migration).not.toMatch(/PASSWORD\s+'/i);
  });
});

describe('backup files stay out of git', () => {
  it('ignores dumps, encrypted dumps, the restore folder and the private key', () => {
    const gitignore = read('.gitignore');
    for (const p of ['*.dump', '*.dump.age', 'restore/', 'gm-backup-key.txt']) {
      expect(gitignore.split('\n')).toContain(p);
    }
  });
});
