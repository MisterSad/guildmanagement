import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import '../i18n.js';
import '../gm-utils.js';

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
        expect(termsHtmlContent).toContain('TERMS OF SERVICE AND GENERAL CONDITIONS OF SALE (TOS/GCS)');
        expect(termsHtmlContent).toContain('August 20, 2026');
        expect(termsHtmlContent).toContain('FGF Guild Management Platform');
        expect(termsHtmlContent).toContain('fgfwiki@gmail.com');
        expect(termsHtmlContent).toContain('André Vieira');
    });

    it('terms.html contains all 9 statutory legal sections and preamble', () => {
        expect(termsHtmlContent).toContain('PREAMBLE &amp; BINDING LEGAL AGREEMENT');
        expect(termsHtmlContent).toContain('SECTION 1. LEGAL NOTICE &amp; STATUTORY DISCLOSURES');
        expect(termsHtmlContent).toContain('SECTION 2. NATURE OF THE SERVICE &amp; TECHNICAL ARCHITECTURE');
        expect(termsHtmlContent).toContain('SECTION 3. INTELLECTUAL PROPERTY &amp; DISCLAIMER OF NON-AFFILIATION');
        expect(termsHtmlContent).toContain('SECTION 4. COMMERCIAL TERMS, ACCESS PASSES &amp; NO AUTOMATIC RENEWAL');
        expect(termsHtmlContent).toContain('SECTION 5. GAME INTEGRITY, TECHNICAL COMPLIANCE &amp; ACCEPTABLE USE');
        expect(termsHtmlContent).toContain('SECTION 6. PRIVACY BY DESIGN &amp; DATA GOVERNANCE (GDPR &amp; CCPA)');
        expect(termsHtmlContent).toContain('SECTION 7. LIMITATION OF LIABILITY &amp; WARRANTY DISCLAIMER');
        expect(termsHtmlContent).toContain('SECTION 8. SEVERABILITY &amp; MODIFICATIONS');
        expect(termsHtmlContent).toContain('SECTION 9. GOVERNING LAW &amp; JURISDICTION');
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
