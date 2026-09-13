/**
 * tests/i18n_core.test.js
 *
 * Golden suite for src/core/i18n/i18n.ts after the legacy root `i18n.js`
 * removal. The full English dictionary (537 keys) is now the single source of
 * truth; window.GM_I18N is provided by tests/setup.js (mirroring src/main.ts).
 */
import { describe, it, expect } from 'vitest';
import { t, getLang, setLang, applyTranslations } from '../src/core/i18n/i18n';
import { EN } from '../src/core/i18n/i18n.dictionary';

describe('i18n dictionary (golden)', () => {
  it('keeps the full 559-key English dictionary', () => {
    expect(Object.keys(EN).length).toBe(559);
  });

  it('has no empty translation value', () => {
    expect(Object.keys(EN).filter((k) => !EN[k])).toEqual([]);
  });

  it('spot-checks known strings', () => {
    expect(t('login_title')).toBe('FGF GUILD MANAGEMENT');
    expect(t('ar_subtitle')).toBe('Track and manage Arms Race stages & scores');
    expect(t('footer_terms')).toBe('Terms & Conditions');
    expect(t('gm_nav_subscription')).toBe('Buy Me a Coffee');
  });

  it('provides an explicit config-save failure toast (RC1)', () => {
    expect(t('toast_config_save_failed', { n: 3 })).toContain('3');
    expect(t('toast_config_save_failed', { n: 3 })).toContain('could not be saved');
  });

  it('is exposed through the setup bridge (window.GM_I18N / window.GM.t)', () => {
    expect(window.GM_I18N.t('login_label_id')).toBe('Identifier');
    expect(window.GM.t('login_label_id')).toBe('Identifier');
  });
});

describe('i18n t()', () => {
  it('returns the exact translation for a known key', () => {
    expect(t('login_label_id')).toBe('Identifier');
  });

  it('falls back to the raw key for an unknown key', () => {
    expect(t('no_such_key_xyz')).toBe('no_such_key_xyz');
  });

  it('supports additive interpolation', () => {
    expect(t('bulk_selected_count', { n: 3 })).toBe('3 selected');
    expect(t('toast_bulk_role_updated', { n: 2, role: 'R4' })).toBe('2 member(s) successfully assigned to rank R4');
  });

  it('leaves placeholders untouched when no replacements are passed', () => {
    expect(t('bulk_selected_count')).toContain('{n}');
  });
});

describe('i18n language API', () => {
  it('getLang() returns en', () => {
    expect(getLang()).toBe('en');
  });

  it('setLang() is a no-op', () => {
    expect(setLang('fr')).toBeUndefined();
    expect(getLang()).toBe('en');
    expect(t('login_title')).toBe('FGF GUILD MANAGEMENT');
  });
});

describe('i18n applyTranslations()', () => {
  it('fills data-i18n, data-i18n-placeholder and data-i18n-title', () => {
    document.body.innerHTML =
      '<span data-i18n="login_title"></span>' +
      '<input data-i18n-placeholder="login_placeholder_id">' +
      '<button data-i18n-title="edit_title"></button>';

    applyTranslations();

    expect(document.querySelector('[data-i18n="login_title"]').textContent).toBe('FGF GUILD MANAGEMENT');
    expect(document.querySelector('input').getAttribute('placeholder')).toBe('Your identifier');
    expect(document.querySelector('button').getAttribute('title')).toBe('Edit');
  });

  it('scopes to the provided root', () => {
    document.body.innerHTML =
      '<div id="a"><span data-i18n="login_title"></span></div>' +
      '<div id="b"><span data-i18n="login_title"></span></div>';

    applyTranslations(document.getElementById('a'));

    expect(document.querySelector('#a span').textContent).toBe('FGF GUILD MANAGEMENT');
    expect(document.querySelector('#b span').textContent).toBe('');
  });
});
