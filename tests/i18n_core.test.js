/**
 * tests/i18n_core.test.js
 *
 * Golden suite for src/core/i18n/i18n.ts after the legacy root `i18n.js`
 * removal. The full English dictionary is the single source of
 * truth. Since M4c there is no GM_I18N / GM.t on window: callers import t().
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { t, getLang, setLang, applyTranslations } from '../src/core/i18n/i18n';
import { EN } from '../src/core/i18n/i18n.dictionary';

describe('i18n dictionary (golden)', () => {
  it('keeps the full 546-key English dictionary', () => {
    // 546 since M5 named two unlabelled clock-dialog fields (a11y_clock_timezone,
    // a11y_clock_offset). 544 since the Discord sign-in redesign added login_invite_banner,
    // login_busy and login_legacy_note. 541 since the audit/officers channel became configurable from the app
    // (label_discord_audit_channel_id and its hint). 539 since ADR-020 added the roster-gate switch
    // (label_discord_verification_require_roster and its _hint). 537 since the
    // recovery-code link was wired (login_recovery). 536 since the
    // login page put Discord first and added login_discord_hint
    // and login_or. 534 since phase 8 added `footer_privacy`, the label on the new Privacy
    // Policy link. 533 since finding B1 added `event_session_started` and
    // `sf_commanders_full`. 531 since finding H2 added `guild_unresolved`, the
    // message shown when the active tenant cannot be resolved -- which used to
    // silently become ALPHA.
    expect(Object.keys(EN).length).toBe(546);
  });

  it('has no empty translation value', () => {
    expect(Object.keys(EN).filter((k) => !EN[k])).toEqual([]);
  });

  it('spot-checks known strings', () => {
    expect(t('login_title')).toBe('FGF GUILD MANAGEMENT');
    expect(t('ar_subtitle')).toBe('Track and manage Arms Race stages & scores');
    expect(t('footer_terms')).toBe('Terms & Conditions');
    expect(t('gm_nav_more')).toBe('More');
    expect(t('modal_add_clock_btn')).toBe('Add Clock');
  });

  it('provides an explicit config-save failure toast (RC1)', () => {
    expect(t('toast_config_save_failed', { n: 3 })).toContain('3');
    expect(t('toast_config_save_failed', { n: 3 })).toContain('could not be saved');
  });

  it('is no longer exposed on window (callers import t())', () => {
    expect(t('login_label_id')).toBe('Identifier');
    expect('GM_I18N' in window).toBe(false);
    expect('GM' in window).toBe(false);
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

describe('B1 — every key the code asks for actually exists', () => {
  // This is the third time this bug has shipped: `modal_add_clock_btn` in
  // eae0842, and `event_session_started` found by the 2026-09 audit. `t()`
  // falls back to the raw key, so the failure is silent to every test and
  // loud to the user -- they see the literal string `event_session_started`
  // in a toast. Counting keys cannot catch it; only cross-checking the call
  // sites can.
  const srcDir = path.resolve(__dirname, '..', 'src');

  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (e.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  const files = walk(srcDir);

  it('finds the t() call sites it is supposed to be checking', () => {
    // Guards the guard: a regex that silently matches nothing would make this
    // whole block vacuous and green forever.
    const total = files.reduce(
      (n, f) => n + (fs.readFileSync(f, 'utf8').match(/\bt\(\s*'[a-z0-9_]+'\s*[),]/g) || []).length,
      0
    );
    expect(total).toBeGreaterThan(150);
  });

  it('has a dictionary entry for every literal key passed to t()', () => {
    const missing = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const re = /\bt\(\s*'([a-z0-9_]+)'\s*[),]/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        if (!Object.prototype.hasOwnProperty.call(EN, m[1])) {
          missing.push(`${path.relative(srcDir, f)}: t('${m[1]}')`);
        }
      }
    }
    expect(missing, `keys called but never defined:\n${missing.join('\n')}`).toEqual([]);
  });

  it('defines the key whose absence the audit found', () => {
    // Only `event_session_started_sf` existed, so every non-Shadowfront
    // session start showed users the raw key.
    expect(EN.event_session_started).toBe('New session started.');
    expect(EN.event_session_started_sf).toContain('Shadowfront');
  });
});
