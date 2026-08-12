/**
 * src/core/i18n/i18n.ts
 *
 * ES Module i18n translation system.
 */

const TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    login_title: 'FGF GUILD MANAGEMENT',
    login_subtitle: 'Foundation Galactic Frontier',
    login_label_id: 'Identifier',
    login_placeholder_id: 'Your identifier',
    login_label_pass: 'Password',
    login_placeholder_pass: 'Your password',
    login_error: 'Invalid credentials.',
    login_btn: 'Access',
    login_btn_loading: 'Logging in...',
    login_discord: 'Want a guild space for your guild? Join our Discord',
    nav_dashboard: 'Command Center',
    nav_members: 'Members',
    nav_admin_label: 'Admin:',
    nav_logout_title: 'Logout',
    admin_title: 'Command Center',
    admin_subtitle: 'Manage access and accounts for the guild',
    card_create_account: 'Create Account',
    label_account_id: 'Account Identifier',
    placeholder_account_id: 'e.g. MemberName',
    btn_generate: 'Generate Access',
    btn_generating: 'Creating...',
    card_active_accounts: 'Active Accounts',
    empty_accounts: 'No accounts generated',
    copy_title: 'Copy password',
    delete_title: 'Delete',
    show_pwd: 'Show / Hide',
    cred_created: 'Created',
    card_guild_settings: 'Guild Settings & Coefficients',
    label_coeff_svs: 'SvS Coeff',
    label_coeff_gvg: 'GvG Coeff',
    label_coeff_shadowfront: 'Shadowfront Coeff',
    label_coeff_dtr: 'DTR Coeff',
    label_coeff_armsrace: 'Arms Race Coeff',
    label_discord_webhook: 'Discord Webhook URL',
    btn_save_config: 'Save Configuration',
    toast_config_updated: 'Guild configuration updated successfully!',
    members_title: 'Guild Members',
    members_subtitle: 'Manage in-game members of Foundation Galactic Frontier',
    card_add_member: 'Add a member',
    label_pseudo: 'In-Game Name (Pseudo)',
    placeholder_pseudo: 'e.g. SpaceCommander',
    label_uid: 'Player UID',
    placeholder_uid: 'Numeric UID',
    label_power: 'Overall Power',
    btn_add_member: 'Add Member',
    btn_adding: 'Adding...',
    card_member_list: 'Members List',
    empty_members: 'No members registered',
    search_placeholder: 'Search by pseudo...',
    filter_role_all: 'All Roles',
    filter_role_r5: 'R5 — Leader',
    filter_role_r4: 'R4 — Officer',
    filter_role_r3: 'R3 — Member',
    filter_role_r2: 'R2 — Member',
    filter_role_r1: 'R1 — Member',
    confirm_delete_account: 'Are you sure you want to delete account "{name}"?',
    confirm_delete_member: 'Are you sure you want to delete member "{name}"?',
    confirm_demote: 'Are you sure you want to demote "{name}" to Member?',
    confirm_promote: 'Promote "{name}" to Officer (R4)?',
    toast_account_created: 'Account "{name}" generated!',
    toast_account_deleted: 'Account deleted.',
    toast_member_added: 'Member "{name}" added!',
    toast_member_deleted: 'Member deleted.',
    toast_role_updated: 'Role updated for {name}.',
    toast_copied: 'Password copied to clipboard!',
    toast_copy_error: 'Unable to copy password.',
    toast_error_auth: 'Incorrect identifier or password.',
    toast_error_network: 'Network connection error.',
    toast_error_unknown: 'An unexpected error occurred.',
    validation_pseudo_empty: 'Please enter a pseudo.',
    validation_pseudo_too_long: 'Pseudo must not exceed 32 characters.',
    validation_pseudo_invalid_chars: 'Pseudo contains forbidden characters.',
    validation_uid_invalid: 'UID is invalid.',
    validation_uid_too_long: 'UID must not exceed 20 characters.',
    validation_uid_not_numeric: 'UID must contain numbers only.',
    tab_dashboard: 'Command Center',
    tab_members: 'Members',
    tab_overview: 'Overview',
    tab_events: 'Active Events',
    tab_stats: 'Participation',
    tab_sanctions: 'Sanctions',
    tab_history: 'Session History',
    tab_armsrace: 'Arms Race',
    tab_shadowfront: 'Shadowfront',
    tab_glory: 'Glory'
  }
};

let currentLang = 'en';

export function t(key: string, replacements?: Record<string, string | number>): string {
  const dict = TRANSLATIONS[currentLang] || TRANSLATIONS['en'];
  let str = dict[key] || TRANSLATIONS['en'][key] || key;
  if (replacements) {
    Object.keys(replacements).forEach((k) => {
      str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), String(replacements[k]));
    });
  }
  return str;
}

export function getLang(): string {
  return currentLang;
}

export function setLang(lang: string): void {
  if (TRANSLATIONS[lang]) currentLang = lang;
}

export function applyTranslations(): void {
  if (typeof document === 'undefined') return;
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  const placeholders = document.querySelectorAll('[data-i18n-placeholder]');
  placeholders.forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) (el as HTMLInputElement).placeholder = t(key);
  });
}

// Expose on window.GM_I18N for full test & legacy compatibility
if (typeof window !== 'undefined') {
  (window as any).GM_I18N = {
    t,
    getLang,
    setLang,
    applyTranslations
  };
}
