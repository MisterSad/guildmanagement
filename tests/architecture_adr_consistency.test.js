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
  // Enumerated from disk, not hardcoded. The previous list stopped at ADR-014
  // and had been stale since ADR-015 was written: four ADRs existed that no
  // test looked at. A list that must be edited by hand to stay true is not a
  // guard, it is a second thing to forget.
  const expectedAdrs = fs.readdirSync(adrDir)
    .filter((f) => /^ADR-\d{3}-.+\.md$/.test(f))
    .sort();

  it('verifies that every ADR file on disk is well formed', () => {
    expect(expectedAdrs.length).toBeGreaterThanOrEqual(19);
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

    for (const file of expectedAdrs) {
      const id = file.slice(0, 7); // ADR-0NN
      expect(readme, `ADR index missing ${id}`).toContain(id);
      expect(readme, `ADR index does not link ${file}`).toContain(file);
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
