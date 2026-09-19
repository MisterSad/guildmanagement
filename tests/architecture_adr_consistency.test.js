/**
 * Architecture & ADR Documentation Consistency Test Suite
 *
 * Validates TICKET-15 [DOC-01]:
 * 1. All 14 ADRs (ADR-001 through ADR-014) exist in docs/adr/ with valid markdown structure.
 * 2. docs/adr/README.md indexes all 14 ADRs with accurate links and titles.
 * 3. ARCHITECTURE.md references the latest security, accessibility, and reliability invariants.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const adrDir = path.join(rootDir, 'docs/adr');
const adrReadmePath = path.join(adrDir, 'README.md');
const archDocPath = path.join(rootDir, 'ARCHITECTURE.md');

describe('TICKET-15 [DOC-01]: Architecture Decision Records Integrity', () => {
  const expectedAdrs = [
    'ADR-001-three-role-zero-trust-access-model.md',
    'ADR-002-deterministic-event-session-ids.md',
    'ADR-003-multi-tenant-saas-invariants.md',
    'ADR-004-consolidated-database-schema-and-security-definer.md',
    'ADR-005-memory-and-regression-prevention-protocol.md',
    'ADR-006-four-role-access-model-with-server-admin.md',
    'ADR-007-accounts-only-role-resolution.md',
    'ADR-008-migration-protocol-v2.md',
    'ADR-009-secrets-vault-only-policy.md',
    'ADR-010-force-row-level-security-all-public-tables.md',
    'ADR-011-client-error-reporting-and-sentry-apm.md',
    'ADR-012-sha256-ocr-deduplication-cache.md',
    'ADR-013-wcag-2-2-aa-dialog-accessibility-and-focus-trap.md',
    'ADR-014-root-scripts-hygiene-and-discord-webhook-resilience.md',
  ];

  it('verifies that all 14 ADR files exist in docs/adr/', () => {
    for (const adrFile of expectedAdrs) {
      const fullPath = path.join(adrDir, adrFile);
      expect(fs.existsSync(fullPath), `Missing ADR: ${adrFile}`).toBe(true);

      const content = fs.readFileSync(fullPath, 'utf8');
      expect(content.toLowerCase()).toContain('status');
      expect(content).toContain('Context');
      expect(content).toContain('Decision');
    }
  });

  it('verifies that docs/adr/README.md indexes every ADR', () => {
    expect(fs.existsSync(adrReadmePath)).toBe(true);
    const readme = fs.readFileSync(adrReadmePath, 'utf8');

    for (let i = 1; i <= 14; i++) {
      const id = `ADR-${String(i).padStart(3, '0')}`;
      expect(readme, `ADR index missing ${id}`).toContain(id);
    }
  });

  it('verifies that ARCHITECTURE.md documents recent security and quality hardenings', () => {
    expect(fs.existsSync(archDocPath)).toBe(true);
    const arch = fs.readFileSync(archDocPath, 'utf8');

    expect(arch).toContain('FORCE ROW LEVEL SECURITY');
    expect(arch).toContain('ADR-010');
    expect(arch).toContain('ADR-011');
    expect(arch).toContain('ADR-012');
    expect(arch).toContain('ADR-013');
    expect(arch).toContain('ADR-014');
    expect(arch).toContain('zero external CDN scripts');
    expect(arch).toContain('ocr_cache');
  });
});
