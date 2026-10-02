/**
 * src/modules/app/dom-refs.ts
 *
 * Sous-lot 6.4 (Strangler) — lazy DOM accessors for the elements app.js used to
 * capture at parse time. Every getter resolves `document.getElementById` at
 * access time; importing this module performs NO DOM lookup. Mirrors the 19
 * parse-time refs from app.js:20-38 plus the router/admin/OCR elements.
 */

export interface DomRefs {
  readonly loginView: HTMLElement | null;
  readonly dashboardView: HTMLElement | null;
  readonly loginForm: HTMLElement | null;
  readonly loginError: HTMLElement | null;
  readonly logoutBtn: HTMLElement | null;
  readonly createAccountForm: HTMLElement | null;
  readonly accountList: HTMLElement | null;
  readonly accountCount: HTMLElement | null;
  readonly toastContainer: HTMLElement | null;
  readonly addMemberForm: HTMLElement | null;
  readonly guildMemberList: HTMLElement | null;
  readonly guildMemberCount: HTMLElement | null;
  readonly addBannedForm: HTMLElement | null;
  readonly bannedListContainer: HTMLElement | null;
  readonly bannedCount: HTMLElement | null;
  readonly bannedSearch: HTMLElement | null;
  readonly adminMembersView: HTMLElement | null;
  readonly accountsManagement: HTMLElement | null;
  readonly guildRequestsSection: HTMLElement | null;
  readonly guildRequestsList: HTMLElement | null;
  readonly adminMembersViewMode: HTMLElement | null;
  readonly ocrModal: HTMLElement | null;
  readonly playerPortalView: HTMLElement | null;
}

/** Call-time element lookup (never cached). */
export function getDomRef(id: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id);
}

/**
 * Returns a fresh accessor object. Each property is resolved on read, so a
 * caller always sees the current DOM (shell re-renders included).
 */
export function getDomRefs(): DomRefs {
  return {
    get loginView() { return getDomRef('login-view'); },
    get dashboardView() { return getDomRef('dashboard-view'); },
    get loginForm() { return getDomRef('login-form'); },
    get loginError() { return getDomRef('login-error'); },
    get logoutBtn() { return getDomRef('logout-btn'); },
    get createAccountForm() { return getDomRef('create-account-form'); },
    get accountList() { return getDomRef('account-list'); },
    get accountCount() { return getDomRef('account-count'); },
    get toastContainer() { return getDomRef('toast-container'); },
    get addMemberForm() { return getDomRef('add-member-form'); },
    get guildMemberList() { return getDomRef('guild-member-list'); },
    get guildMemberCount() { return getDomRef('guild-member-count'); },
    get addBannedForm() { return getDomRef('add-banned-form'); },
    get bannedListContainer() { return getDomRef('banned-list-container'); },
    get bannedCount() { return getDomRef('banned-count'); },
    get bannedSearch() { return getDomRef('banned-search'); },
    get adminMembersView() { return getDomRef('admin-members'); },
    get accountsManagement() { return getDomRef('admin-home'); },
    get guildRequestsSection() { return getDomRef('admin-superadmin'); },
    get guildRequestsList() { return getDomRef('guild-requests-list'); },
    get adminMembersViewMode() { return getDomRef('admin-members-view-mode'); },
    get ocrModal() { return getDomRef('ocr-modal-overlay'); },
    get playerPortalView() { return getDomRef('player-portal-view'); }
  };
}
