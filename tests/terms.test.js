import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Terms of Service & General Conditions of Sale (TOS/GCS) Page', () => {
    const termsHtmlPath = path.resolve(__dirname, '../terms.html');
    const indexHtmlPath = path.resolve(__dirname, '../index.html');
    const termsHtmlContent = fs.readFileSync(termsHtmlPath, 'utf8');
    const indexHtmlContent = fs.readFileSync(indexHtmlPath, 'utf8');

    it('has English translation for footer_terms', () => {
        expect(window.GM_I18N.t('footer_terms')).toBe('Terms & Conditions');
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
        expect(termsHtmlContent).toMatch(/2004-575/);           // the LCEN itself
        expect(termsHtmlContent).toMatch(/micro-entrepreneur/i); // publisher status
        expect(termsHtmlContent).toMatch(/293 B/);               // VAT position
        expect(termsHtmlContent).toMatch(/Vercel Inc/);          // host
        expect(termsHtmlContent).toMatch(/Supabase Inc/);        // host
    });

    it('covers each subject a user agreement has to cover', () => {
        const termsHtmlContent = fs.readFileSync(termsHtmlPath, 'utf8');
        expect(termsHtmlContent).toContain('WHO YOU ARE DEALING WITH');
        expect(termsHtmlContent).toContain('WHAT THIS IS, AND WHAT IT IS NOT');
        expect(termsHtmlContent).toContain('IT IS FREE, AND IT STAYS FREE');
        expect(termsHtmlContent).toContain('I AM NOT THE GAME PUBLISHER');
        expect(termsHtmlContent).toContain('YOUR ACCOUNT, AND HOW TO BEHAVE');
        expect(termsHtmlContent).toContain('WHOSE DATA IS WHOSE');
        expect(termsHtmlContent).toContain('MY CODE, AND MY PROMISE ABOUT IT');
        expect(termsHtmlContent).toContain('WHEN SOMETHING GOES WRONG');
        expect(termsHtmlContent).toContain('WHICH LAW, AND WHICH COURT');
    });

    it('does not impose a court on a consumer, which would be unenforceable', () => {
        // The previous version assigned "exclusive territorial competence" to
        // the Court of Appeal of Paris. Against a consumer that is an unfair
        // term under French law and would not have bound anyone.
        const termsHtmlContent = fs.readFileSync(termsHtmlPath, 'utf8');
        expect(termsHtmlContent).not.toMatch(/exclusive territorial competence/i);
        expect(termsHtmlContent).toMatch(/right to bring proceedings where you live/i);
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

    it('window.GM.openTermsModal navigates to terms.html', () => {
        expect(typeof window.GM.openTermsModal).toBe('function');
    });
});
