import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { t } from '../src/core/i18n/i18n';
import { openTermsModal } from '../src/core/dom/ui';

describe('Terms of Service & General Conditions of Sale (TOS/GCS) Page', () => {
  const termsHtmlPath = path.resolve(__dirname, '../terms.html');
  const indexHtmlPath = path.resolve(__dirname, '../index.html');
  const termsHtmlContent = fs.readFileSync(termsHtmlPath, 'utf8');
  const indexHtmlContent = fs.readFileSync(indexHtmlPath, 'utf8');

  it('has English translation for footer_terms', () => {
    expect(t('footer_terms')).toBe('Terms & Conditions');
  });

  it('terms.html exists and contains full legal document title and metadata', () => {
    expect(fs.existsSync(termsHtmlPath)).toBe(true);
    // The Terms were rewritten on 2026-09-27 for a free community app, in
    // plain English rather than the previous block-capital style. What is
    // pinned here is what the document must SAY to be lawful and honest,
    // not the headings it used to carry.
    expect(termsHtmlContent).toContain('TERMS OF USE');
    expect(termsHtmlContent).toContain('September 27, 2026');
    expect(termsHtmlContent).toContain('FGF Guild Management Platform');
    expect(termsHtmlContent).toContain('fgfwiki@gmail.com');
    expect(termsHtmlContent).toContain('André Vieira');
  });

  it('carries the statutory identification the LCEN requires', () => {
    const termsHtmlContent = fs.readFileSync(termsHtmlPath, 'utf8');
    // The owner publishes on a NON-PROFESSIONAL basis and relies on
    // LCEN art. 1-1, II, which permits disclosing the hosting providers
    // alone provided his identifying particulars were given to them. So the
    // page must NOT carry his domicile or telephone number, and must say
    // which limb it relies on. The micro-entrepreneur and VAT mentions were
    // dropped: invoking II while advertising a registered trading status
    // undercuts the very basis relied upon.
    expect(termsHtmlContent).toMatch(/2004-575/); // the LCEN
    expect(termsHtmlContent).toMatch(/Article 1-1, II/); // the limb relied on
    expect(termsHtmlContent).toMatch(/non-professional basis/i);
    expect(termsHtmlContent).toMatch(/Vercel Inc/); // host
    expect(termsHtmlContent).toMatch(/Supabase Inc/); // host
    expect(termsHtmlContent).toMatch(/right of reply/i); // art. 1-1, III
    expect(termsHtmlContent).toMatch(/three months/i);
  });

  it('covers each subject a user agreement has to cover', () => {
    const termsHtmlContent = fs.readFileSync(termsHtmlPath, 'utf8');
    expect(termsHtmlContent).toContain('LEGAL NOTICE AND IDENTIFICATION OF THE PUBLISHER');
    expect(termsHtmlContent).toContain('DEFINITIONS');
    expect(termsHtmlContent).toContain('SUBJECT MATTER AND NATURE OF THE SERVICE');
    expect(termsHtmlContent).toContain('NO CONSIDERATION, AND THE CONSEQUENCES');
    expect(termsHtmlContent).toContain('INDEPENDENCE FROM THE GAME PUBLISHER');
    expect(termsHtmlContent).toContain('ACCOUNTS, CONDUCT AND MODERATION');
    expect(termsHtmlContent).toContain('INTELLECTUAL PROPERTY AND OPEN-SOURCE UNDERTAKING');
    expect(termsHtmlContent).toContain('LIABILITY');
    expect(termsHtmlContent).toContain('GOVERNING LAW, CLAIMS AND JURISDICTION');
    // A contract of adhesion has to acknowledge the two rules that govern it.
    expect(termsHtmlContent).toMatch(/contract of adhesion/i);
    expect(termsHtmlContent).toMatch(/Article 1171/);
    expect(termsHtmlContent).toMatch(/deemed unwritten/i);
  });

  it('does not impose a court on a consumer, which would be unenforceable', () => {
    // The previous version assigned "exclusive territorial competence" to
    // the Court of Appeal of Paris. Against a consumer that is an unfair
    // term under French law and would not have bound anyone.
    const termsHtmlContent = fs.readFileSync(termsHtmlPath, 'utf8');
    expect(termsHtmlContent).not.toMatch(/exclusive territorial competence/i);
    expect(termsHtmlContent).toMatch(/No exclusive jurisdiction clause is stipulated/i);
    expect(termsHtmlContent).toMatch(/courts of the place where they are domiciled/i);
    // The instrument that gives a consumer that right, cited by name.
    expect(termsHtmlContent).toMatch(/1215\/2012/);
  });

  it('makes the open-source undertaking, with both triggers', () => {
    // The owner's commitment: the code opens if he announces he has stopped,
    // or if twelve months pass with no deployment and no reply. The second
    // trigger is the one that does not depend on him being around.
    const termsHtmlContent = fs.readFileSync(termsHtmlPath, 'utf8');
    expect(termsHtmlContent).toMatch(/Apache License, Version 2\.0/);
    expect(termsHtmlContent).toMatch(/Business Source License 1\.1/);
    expect(termsHtmlContent).toMatch(/2 August 2029/);
    expect(termsHtmlContent).toMatch(/publicly announce/i);
    expect(termsHtmlContent).toMatch(/twelve consecutive months/i);
    expect(termsHtmlContent).toMatch(/irrevocab/i);

    // And it must be mirrored in LICENSE, or the two can be read apart.
    const license = fs.readFileSync(path.resolve(__dirname, '../LICENSE'), 'utf8');
    expect(license).toMatch(/Accelerated Change Date/);
    expect(license).toMatch(/twelve \(12\) consecutive months/);
    expect(license).toMatch(/does not reserve the right to withdraw it/);
  });

  it('terms.html includes navigation controls back to the platform', () => {
    expect(termsHtmlContent).toContain('Return to Platform');
    expect(termsHtmlContent).toContain('href="/"');
  });

  it('index.html links directly to terms.html in footers', () => {
    expect(indexHtmlContent).toContain('href="terms.html" id="terms-link"');
    expect(indexHtmlContent).toContain('href="terms.html" class="gm-footer-link gm-terms-trigger"');
  });

  it('openTermsModal navigates to terms.html', () => {
    expect(typeof openTermsModal).toBe('function');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/core/dom/ui.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function openTermsModal'));
    expect(body.slice(0, body.indexOf('\n}'))).toContain("window.location.href = 'terms.html'");
  });
});
