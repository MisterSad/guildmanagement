import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../i18n.js';
import '../gm-utils.js';

describe('Terms of Service & General Conditions of Sale (TOS/GCS)', () => {
    let overlay;
    let card;
    let closeBtn;
    let bottomCloseBtn;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="login-view" class="view active">
                <div class="gm-login-footer">
                    <span>Developed by HawkEye #1058</span>
                    <span class="gm-footer-sep">•</span>
                    <a href="#terms" id="terms-link" class="gm-footer-link" data-i18n="footer_terms">Terms &amp; Conditions</a>
                </div>
            </div>
            <div id="player-portal-view" class="view hidden">
                <div class="gm-login-footer">
                    <span>Developed by HawkEye #1058</span>
                    <span class="gm-footer-sep">•</span>
                    <a href="#terms" class="gm-footer-link gm-terms-trigger" data-i18n="footer_terms">Terms &amp; Conditions</a>
                </div>
            </div>
            <div id="terms-modal-overlay" class="confirm-overlay" style="display: none;">
                <div class="gm-modal-card gm-terms-modal-card">
                    <button id="terms-modal-close"></button>
                    <div class="gm-terms-modal-body">
                        <div class="gm-terms-preamble-card">PREAMBLE &amp; BINDING LEGAL AGREEMENT</div>
                        <div>SECTION 1. LEGAL NOTICE &amp; STATUTORY DISCLOSURES</div>
                        <div>SECTION 2. NATURE OF THE SERVICE &amp; TECHNICAL ARCHITECTURE</div>
                        <div>SECTION 3. INTELLECTUAL PROPERTY &amp; DISCLAIMER OF NON-AFFILIATION</div>
                        <div>SECTION 4. COMMERCIAL TERMS, ACCESS PASSES &amp; NO AUTOMATIC RENEWAL</div>
                        <div>SECTION 5. GAME INTEGRITY, TECHNICAL COMPLIANCE &amp; ACCEPTABLE USE</div>
                        <div>SECTION 6. PRIVACY BY DESIGN &amp; DATA GOVERNANCE (GDPR &amp; CCPA)</div>
                        <div>SECTION 7. LIMITATION OF LIABILITY &amp; WARRANTY DISCLAIMER</div>
                        <div>SECTION 8. SEVERABILITY &amp; MODIFICATIONS</div>
                        <div>SECTION 9. GOVERNING LAW &amp; JURISDICTION</div>
                    </div>
                    <button id="terms-modal-bottom-close"></button>
                </div>
            </div>
        `;

        overlay = document.getElementById('terms-modal-overlay');
        card = overlay.querySelector('.gm-modal-card');
        closeBtn = document.getElementById('terms-modal-close');
        bottomCloseBtn = document.getElementById('terms-modal-bottom-close');
    });

    afterEach(() => {
        document.body.innerHTML = '';
        window.location.hash = '';
    });

    it('has English translation for footer_terms', () => {
        expect(window.GM_I18N.t('footer_terms')).toBe('Terms & Conditions');
    });

    it('opens and closes terms modal via window.GM methods', () => {
        expect(overlay.style.display).toBe('none');
        expect(overlay.classList.contains('visible')).toBe(false);

        window.GM.openTermsModal();
        expect(overlay.style.display).toBe('flex');
        expect(overlay.classList.contains('visible')).toBe(true);
        expect(document.body.style.overflow).toBe('hidden');

        window.GM.closeTermsModal();
        expect(overlay.classList.contains('visible')).toBe(false);
        expect(document.body.style.overflow).toBe('');
    });

    it('triggers open on clicking #terms-link', () => {
        const link = document.getElementById('terms-link');
        link.click();
        expect(overlay.classList.contains('visible')).toBe(true);
    });

    it('triggers open on clicking .gm-terms-trigger', () => {
        const trigger = document.querySelector('.gm-terms-trigger');
        trigger.click();
        expect(overlay.classList.contains('visible')).toBe(true);
    });

    it('closes on clicking top close button', () => {
        window.GM.openTermsModal();
        expect(overlay.classList.contains('visible')).toBe(true);

        closeBtn.click();
        expect(overlay.classList.contains('visible')).toBe(false);
    });

    it('closes on clicking bottom close button', () => {
        window.GM.openTermsModal();
        expect(overlay.classList.contains('visible')).toBe(true);

        bottomCloseBtn.click();
        expect(overlay.classList.contains('visible')).toBe(false);
    });

    it('closes on backdrop click outside modal card', () => {
        window.GM.openTermsModal();
        expect(overlay.classList.contains('visible')).toBe(true);

        // Click overlay itself
        overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(overlay.classList.contains('visible')).toBe(false);
    });

    it('closes on Escape key press', () => {
        window.GM.openTermsModal();
        expect(overlay.classList.contains('visible')).toBe(true);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(overlay.classList.contains('visible')).toBe(false);
    });
});
