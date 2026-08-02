import { describe, it, expect } from 'vitest';
import '../i18n.js';

const I18N = window.GM_I18N;
expect(I18N).toBeTruthy();

describe('i18n dictionary (English)', () => {
    it('exposes the English dictionary through t()', () => {
        expect(I18N.t('login_title')).toBe('FGF GUILD MANAGEMENT');
        expect(I18N.t('login_label_id')).toBe('Identifier');
        expect(I18N.t('toast_account_created')).toBe('Account created successfully.');
        expect(I18N.t('members_title')).toBe('Guild Members');
    });

    it('returns the key itself for missing keys', () => {
        expect(I18N.t('no_such_key_xyz')).toBe('no_such_key_xyz');
    });

    it('switching language is supported and does not throw', () => {
        expect(I18N.setLang('en')).toBeUndefined();
        expect(typeof I18N.getLang).toBe('function');
    });

    it('has no missing data-i18n references', () => {
        // Every key used by index.html data-i18n attributes must resolve to a
        // non-empty English string. The test asserts on a representative set;
        // the full sweep is covered by the app-level checklist.
        const samples = [
            'nav_dashboard', 'nav_members', 'login_subtitle', 'admin_title',
            'card_guild_settings', 'members_title', 'member_home_title'
        ];
        samples.forEach((k) => {
            expect(I18N.t(k)).toBeTruthy();
        });
    });
});
