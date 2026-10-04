/**
 * src/modules/migration/views/MigrationHubView.ts
 *
 * Migration Hub View: Collaborative wiki, intel sharing, and screenshot management
 * for cross-server migrations with dual Guild and Server scopes.
 */

import { styleRef } from '../../../core/dom/style-refs';
import { escapeHTML } from '../../../core/utils/text';
import { debounce } from '../../../core/utils/async';
import { getActiveGuild, currentAccountId, getCurrentPseudo, roleFromStorage } from '../../../core/auth/roles';
import { getClient } from '../../../core/api/supabase';
import { getAppState } from '../../../core/state/app-state';
import { showToast } from '../../../core/dom/toast';
import { showConfirm } from '../../app/dialogs/dialogs.service';
import { compressImage, extractImagesFromClipboard, extractImagesFromDrop } from '../../../core/utils/image-compressor';
import {
  MigrationWikiPage,
  MigrationWikiAttachment,
  MigrationWikiScope,
  MigrationWikiCategory,
  MigrationHubFilterState,
  MigrationWikiComment,
} from '../types';
import {
  queryWikiPages,
  updateWikiPage,
  insertWikiPage,
  setWikiPagePinned,
  deleteWikiPage,
  queryWikiComments,
  insertWikiComment,
  deleteWikiComment,
  requestPageSummary,
  requestScopeBriefing,
} from '../migration.service';

/**
 * Server number of a guild, from the cached guild list, else the caller's
 * server restriction.
 */
function getServerNumber(guildId: string): string {
  const entry = getAppState().guildsData[guildId];
  if (entry && entry.server_number) return String(entry.server_number);
  const store = typeof localStorage !== 'undefined' ? localStorage : null;
  return store ? store.getItem('gm_server_restriction') || '' : '';
}

const CATEGORY_LABELS: Record<MigrationWikiCategory, string> = {
  general: 'General',
  strategy: 'Strategy',
  agreements: 'Agreements',
  diplomacy: 'Diplomacy',
  recruitment: 'Recruitment',
  blacklist: 'Blacklist',
};

const CATEGORY_CHIP_CLASSES: Record<MigrationWikiCategory, string> = {
  general: 'gm-chip-default',
  strategy: 'gm-chip-purple',
  agreements: 'gm-chip-blue',
  diplomacy: 'gm-chip-blue',
  recruitment: 'gm-chip-success',
  blacklist: 'gm-chip-danger',
};

/**
 * Mirrors the gm_migration_wiki_update / _delete policies: a page belongs to the
 * guild that wrote it, and only that guild (or a super admin) edits or deletes it.
 */
export function canManageWikiPage(
  page: { owner_guild?: string | null },
  guild: string | null,
  role: string | null
): boolean {
  if (role === 'super_admin') return true;
  return !!guild && !!page.owner_guild && page.owner_guild === guild;
}

export class MigrationHubView {
  private pages: MigrationWikiPage[] = [];
  private activeComments: MigrationWikiComment[] = [];
  private filterState: MigrationHubFilterState = {
    scope: 'guild',
    category: 'all',
    searchQuery: '',
    activePageId: null,
  };

  private editingPageId: string | null = null;
  private pendingAttachments: MigrationWikiAttachment[] = [];
  private realtimeChannel: any = null;
  private commentsRealtimeChannel: any = null;
  private initialized = false;
  /**
   * Collapses a burst of remote wiki edits into a single refetch.
   *
   * The guard matters: `debounce` exposes no cancel, so a reload scheduled just
   * before the user navigates away would otherwise fire AFTER `destroy()` and
   * re-subscribe the very channels it had just removed -- reintroducing the leak
   * this teardown exists to close. `realtimeChannel` is precisely the "still
   * mounted" condition: `subscribeRealtime()` sets it, `destroy()` nulls it.
   */
  private readonly reloadFromRealtime = debounce(() => {
    if (!this.realtimeChannel) return;
    void this.load();
  }, 800);

  /**
   * Initializes DOM listeners for the Migration Hub view. Idempotent.
   */
  public init(): void {
    if (this.initialized) return;

    // Scope toggle buttons
    const guildBtn = document.getElementById('migration-hub-scope-guild-btn');
    const serverBtn = document.getElementById('migration-hub-scope-server-btn');
    guildBtn?.addEventListener('click', () => this.switchScope('guild'));
    serverBtn?.addEventListener('click', () => this.switchScope('server'));

    // Category filter buttons
    const catContainer = document.getElementById('migration-hub-category-filters');
    catContainer?.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('button[data-cat]') as HTMLElement | null;
      if (!target) return;
      const cat = target.getAttribute('data-cat') || 'all';
      this.filterState.category = cat;

      catContainer.querySelectorAll('button[data-cat]').forEach((btn) => {
        btn.classList.remove('gm-chip-active');
      });
      target.classList.add('gm-chip-active');
      this.renderPagesList();
    });

    // Search input
    const searchInput = document.getElementById('migration-hub-search') as HTMLInputElement | null;
    searchInput?.addEventListener('input', () => {
      this.filterState.searchQuery = (searchInput.value || '').trim().toLowerCase();
      this.renderPagesList();
    });

    // New Page button
    const newPageBtn = document.getElementById('migration-hub-new-page-btn');
    newPageBtn?.addEventListener('click', () => this.startNewPage());

    const emptyNewBtn = document.getElementById('migration-hub-empty-new-btn');
    emptyNewBtn?.addEventListener('click', () => this.startNewPage());

    // Form submit & cancel
    const form = document.getElementById('migration-hub-form') as HTMLFormElement | null;
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleFormSubmit();
    });

    const cancelBtn = document.getElementById('migration-hub-form-cancel-btn');
    cancelBtn?.addEventListener('click', () => this.cancelEditing());

    // Comment form submit
    const commentForm = document.getElementById('migration-hub-comment-form') as HTMLFormElement | null;
    commentForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleCommentSubmit();
    });

    // Page action buttons
    const editBtn = document.getElementById('migration-hub-edit-btn');
    editBtn?.addEventListener('click', () => {
      if (this.filterState.activePageId) {
        this.startEditPage(this.filterState.activePageId);
      }
    });

    const pinBtn = document.getElementById('migration-hub-pin-toggle-btn');
    pinBtn?.addEventListener('click', () => this.togglePinCurrentPage());

    const discordBtn = document.getElementById('migration-hub-export-discord-btn');
    discordBtn?.addEventListener('click', () => this.exportCurrentPageToDiscord());

    const deleteBtn = document.getElementById('migration-hub-delete-btn');
    deleteBtn?.addEventListener('click', () => this.deleteCurrentPage());

    // Markdown toolbar
    const toolbar = document.querySelector('.gm-wiki-toolbar');
    toolbar?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLElement | null;
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      if (action) this.applyMarkdownFormat(action);
    });

    // Screenshot dropzone & file picker
    const dropzone = document.getElementById('migration-hub-dropzone');
    const fileInput = document.getElementById('migration-hub-file-input') as HTMLInputElement | null;

    dropzone?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      if (fileInput.files) this.handleFilesAdded(Array.from(fileInput.files));
      fileInput.value = '';
    });

    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--accent)';
    });

    dropzone?.addEventListener('dragleave', () => {
      dropzone.style.borderColor = 'var(--border-soft)';
    });

    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--border-soft)';
      const files = extractImagesFromDrop(e);
      if (files.length > 0) this.handleFilesAdded(files);
    });

    // Paste event for screenshots anywhere in form
    const formElement = document.getElementById('migration-hub-edit-card');
    formElement?.addEventListener('paste', (e) => {
      const files = extractImagesFromClipboard(e as ClipboardEvent);
      if (files.length > 0) {
        e.preventDefault();
        this.handleFilesAdded(files);
      }
    });

    // Lightbox modal close
    const lightbox = document.getElementById('migration-hub-lightbox');
    const lightboxClose = document.getElementById('migration-hub-lightbox-close');
    lightboxClose?.addEventListener('click', () => {
      if (lightbox) lightbox.style.display = 'none';
    });
    lightbox?.addEventListener('click', (e) => {
      if (e.target === lightbox) lightbox.style.display = 'none';
    });

    // AI Summary & Digest buttons
    const aiSummaryBtn = document.getElementById('migration-hub-ai-summary-btn');
    aiSummaryBtn?.addEventListener('click', () => this.generatePageSummary());

    const copyAiSummaryBtn = document.getElementById('migration-hub-copy-ai-summary-btn');
    copyAiSummaryBtn?.addEventListener('click', () => {
      if (this.currentAiSummary) {
        navigator.clipboard.writeText(this.currentAiSummary);
        showToast('Copied AI summary to clipboard!', 'success');
      }
    });

    const closeAiSummaryBtn = document.getElementById('migration-hub-close-ai-summary-btn');
    closeAiSummaryBtn?.addEventListener('click', () => {
      const box = document.getElementById('migration-hub-page-ai-box');
      if (box) box.style.display = 'none';
    });

    const aiDigestBtn = document.getElementById('migration-hub-ai-digest-btn');
    aiDigestBtn?.addEventListener('click', () => this.generateScopeBriefing());

    const digestModal = document.getElementById('migration-hub-ai-digest-modal');
    const digestClose = () => {
      if (digestModal) digestModal.style.display = 'none';
    };
    document.getElementById('migration-hub-digest-modal-close')?.addEventListener('click', digestClose);
    document.getElementById('migration-hub-digest-close-btn')?.addEventListener('click', digestClose);
    digestModal?.addEventListener('click', (e) => {
      if (e.target === digestModal) digestClose();
    });

    document.getElementById('migration-hub-digest-copy-btn')?.addEventListener('click', () => {
      if (this.currentAiBriefing) {
        navigator.clipboard.writeText(this.currentAiBriefing);
        showToast('Copied briefing to clipboard!', 'success');
      }
    });

    this.initialized = true;
  }

  private currentAiSummary = '';
  private currentAiBriefing = '';

  /**
   * Loads wiki pages from Supabase for the current scope and sets up Realtime sync.
   */
  public async load(): Promise<void> {
    this.init();
    const db = getClient();
    if (!db) return;

    const currentG = getActiveGuild();
    if (!currentG) return;
    const serverNumber = getServerNumber(currentG);

    // Update scope switcher labels
    const guildLabel = document.getElementById('migration-hub-guild-label');
    if (guildLabel) guildLabel.textContent = `Guild Intel [${currentG}]`;

    const serverLabel = document.getElementById('migration-hub-server-label');
    if (serverLabel) serverLabel.textContent = `Server Intel [${serverNumber || '?'}]`;

    try {
      const query = queryWikiPages(db, this.filterState.scope, currentG, serverNumber);

      const { data, error } = await query;
      if (error) {
        console.error('[MigrationHub] Failed to fetch pages', error);
        showToast('Failed to load migration pages: ' + (error.message || 'Unknown error'), 'error');
        return;
      }

      this.pages = (data || []).map((row: any) => ({
        ...row,
        attachments: Array.isArray(row.attachments) ? row.attachments : [],
      })) as MigrationWikiPage[];

      // If activePageId is null or not in pages, select first page if available
      if (!this.filterState.activePageId || !this.pages.some((p) => p.id === this.filterState.activePageId)) {
        this.filterState.activePageId = this.pages.length > 0 ? this.pages[0].id : null;
      }

      this.renderPagesList();
      this.renderActivePage();
      this.subscribeRealtime();
    } catch (err: any) {
      console.error('[MigrationHub] load exception', err);
    }
  }

  /**
   * Subscribes to Supabase Realtime channel for collaborative updates.
   */
  private subscribeRealtime(): void {
    const db = getClient();
    if (!db || typeof db.channel !== 'function') return;

    if (!this.realtimeChannel) {
      this.realtimeChannel = db
        .channel('public:migration_wiki_pages')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'migration_wiki_pages' }, () => {
          // Any remote change re-runs a full select('*') of the wiki table,
          // so an unthrottled handler meant that with n admins editing, each
          // edit cost n full refetches. Debounced: a burst of edits (a rename
          // followed by a body save, or several people typing) collapses into
          // one refetch instead of one per event.
          this.reloadFromRealtime();
        })
        .subscribe();
    }

    if (!this.commentsRealtimeChannel) {
      this.commentsRealtimeChannel = db
        .channel('public:migration_wiki_comments')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'migration_wiki_comments' }, (payload: any) => {
          const activePageId = this.filterState.activePageId;
          if (activePageId && (payload.new?.page_id === activePageId || payload.old?.page_id === activePageId)) {
            this.loadComments(activePageId);
          }
        })
        .subscribe();
    }
  }

  /**
   * Switches scope between 'guild' and 'server'.
   */
  public switchScope(scope: MigrationWikiScope): void {
    if (this.filterState.scope === scope) return;
    this.filterState.scope = scope;
    this.filterState.activePageId = null;
    this.cancelEditing();

    const guildBtn = document.getElementById('migration-hub-scope-guild-btn');
    const serverBtn = document.getElementById('migration-hub-scope-server-btn');

    if (scope === 'guild') {
      guildBtn?.classList.add('active');
      guildBtn?.style.setProperty('background', 'var(--accent-strong)');
      guildBtn?.style.setProperty('color', '#fff');
      serverBtn?.classList.remove('active');
      serverBtn?.style.setProperty('background', 'transparent');
      serverBtn?.style.setProperty('color', 'var(--text-muted)');
    } else {
      serverBtn?.classList.add('active');
      serverBtn?.style.setProperty('background', 'var(--accent-strong)');
      serverBtn?.style.setProperty('color', '#fff');
      guildBtn?.classList.remove('active');
      guildBtn?.style.setProperty('background', 'transparent');
      guildBtn?.style.setProperty('color', 'var(--text-muted)');
    }

    this.load();
  }

  /**
   * Filters and renders the left column pages list.
   */
  private renderPagesList(): void {
    const container = document.getElementById('migration-hub-pages-container');
    if (!container) return;

    const filtered = this.pages.filter((p) => {
      const matchesCat = this.filterState.category === 'all' || p.category === this.filterState.category;
      const matchesSearch =
        !this.filterState.searchQuery ||
        p.title.toLowerCase().includes(this.filterState.searchQuery) ||
        p.content.toLowerCase().includes(this.filterState.searchQuery) ||
        p.created_by_pseudo.toLowerCase().includes(this.filterState.searchQuery);
      return matchesCat && matchesSearch;
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="u-p-1_5rem-0_5rem gm-empty">
          <i class="ph ph-newspaper-clipping gm-icon"></i>
          <div class="u-fs-0_88rem gm-empty-title">No pages found</div>
          <p class="u-fs-0_75rem u-c-text-muted u-mt-0_25rem">Click "New Wiki Page" to create one.</p>
        </div>
      `;
      return;
    }

    let html = '';
    filtered.forEach((page) => {
      const isActive = page.id === this.filterState.activePageId;
      const catLabel = CATEGORY_LABELS[page.category] || page.category;
      const catClass = CATEGORY_CHIP_CLASSES[page.category] || 'gm-chip-default';
      const attachCount = page.attachments ? page.attachments.length : 0;
      const dateStr = new Date(page.updated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

      html += `
        <div class="gm-card gm-card-padded gm-wiki-nav-item ${isActive ? 'active' : ''}" data-page-id="${escapeHTML(page.id)}" data-gm-style="${styleRef(`padding:0.75rem; cursor:pointer; border:1px solid ${isActive ? 'var(--accent)' : 'var(--border-soft)'}; background:${isActive ? 'rgba(var(--accent-rgb, 59, 130, 246), 0.12)' : 'var(--bg-card)'}; border-radius:6px; transition:all 0.15s;`)}">
          <div class="u-d-flex u-justify-space-between u-items-flex-start u-mb-0_25rem">
            <div class="u-fw-700 u-fs-0_88rem u-c-fg u-lh-1_3 u-overflow-hidden u-to-ellipsis u-d-webkit-box u-wclamp-2 u-wbox-vertical">
              ${page.is_pinned ? '<i class="u-c-warning u-mr-3px ph ph-push-pin"></i>' : ''}
              ${escapeHTML(page.title)}
            </div>
            <span class="u-fs-0_68rem u-p-1px-6px u-shrink-0 u-ml-0_4rem gm-chip ${catClass}">${escapeHTML(catLabel)}</span>
          </div>
          <div class="u-d-flex u-justify-space-between u-items-center u-fs-0_72rem u-c-text-muted u-mt-0_4rem">
            <span>${escapeHTML(page.updated_by_pseudo || page.created_by_pseudo)} · ${escapeHTML(dateStr)}</span>
            ${attachCount > 0 ? `<span class="u-d-flex u-items-center u-gap-2px"><i class="ph ph-image"></i> ${attachCount}</span>` : ''}
          </div>
        </div>
      `;
    });

    container.innerHTML = html;

    container.querySelectorAll('.gm-wiki-nav-item').forEach((el) => {
      el.addEventListener('click', () => {
        const pid = el.getAttribute('data-page-id');
        if (pid) {
          this.filterState.activePageId = pid;
          this.cancelEditing();
          this.renderPagesList();
          this.renderActivePage();
        }
      });
    });
  }

  /**
   * Renders the right column with the currently active page in Read mode.
   */
  private renderActivePage(): void {
    const viewCard = document.getElementById('migration-hub-view-card');
    const editCard = document.getElementById('migration-hub-edit-card');
    const viewEmpty = document.getElementById('migration-hub-view-empty');
    const viewDetail = document.getElementById('migration-hub-view-detail');
    if (!viewCard || !editCard) return;

    viewCard.style.display = 'block';
    editCard.style.display = 'none';

    const activePage = this.pages.find((p) => p.id === this.filterState.activePageId);
    if (!activePage) {
      this.activeComments = [];
      if (viewEmpty) {
        viewEmpty.style.display = 'block';
        const emptyDesc = document.getElementById('migration-hub-empty-desc');
        if (emptyDesc) {
          emptyDesc.textContent = `Capture intel, notes, and screenshots for your ${this.filterState.scope === 'guild' ? 'guild' : 'server'}.`;
        }
      }
      if (viewDetail) viewDetail.style.display = 'none';
      return;
    }

    if (viewEmpty) viewEmpty.style.display = 'none';
    if (viewDetail) viewDetail.style.display = 'block';

    // Only the author guild or a super admin may edit or delete the page
    // (policies gm_migration_wiki_update / _delete). A refused write must not
    // look like a success, so the buttons only show when it would be accepted.
    const canManage = canManageWikiPage(activePage, getActiveGuild(), roleFromStorage());
    const delBtn = document.getElementById('migration-hub-delete-btn');
    if (delBtn) delBtn.style.display = canManage ? '' : 'none';
    const editBtnEl = document.getElementById('migration-hub-edit-btn');
    if (editBtnEl) editBtnEl.style.display = canManage ? '' : 'none';

    // Reset AI summary box
    const aiBox = document.getElementById('migration-hub-page-ai-box');
    if (aiBox) aiBox.style.display = 'none';
    this.currentAiSummary = '';

    // Set badges
    const catBadge = document.getElementById('migration-hub-view-category-badge');
    if (catBadge) {
      catBadge.textContent = CATEGORY_LABELS[activePage.category] || activePage.category;
      catBadge.className = `gm-chip ${CATEGORY_CHIP_CLASSES[activePage.category] || 'gm-chip-default'}`;
    }

    const pinnedBadge = document.getElementById('migration-hub-view-pinned-badge');
    if (pinnedBadge) {
      pinnedBadge.style.display = activePage.is_pinned ? 'inline-flex' : 'none';
    }

    const scopeBadge = document.getElementById('migration-hub-view-scope-badge');
    if (scopeBadge) {
      scopeBadge.textContent =
        activePage.scope === 'guild' ? `Guild [${activePage.guild_id || ''}]` : `Server [${activePage.server_number}]`;
    }

    // Set title & meta
    const titleEl = document.getElementById('migration-hub-view-title');
    if (titleEl) titleEl.textContent = activePage.title;

    const metaEl = document.getElementById('migration-hub-view-meta');
    if (metaEl) {
      const createdDate = new Date(activePage.created_at).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const updatedDate = new Date(activePage.updated_at).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      metaEl.textContent = `Created by ${activePage.created_by_pseudo} on ${createdDate} · Last updated by ${activePage.updated_by_pseudo || activePage.created_by_pseudo} on ${updatedDate}`;
    }

    // Render markdown content
    const contentEl = document.getElementById('migration-hub-view-content');
    if (contentEl) {
      contentEl.innerHTML = this.renderMarkdown(activePage.content || '*No content provided.*');
    }

    // Render screenshots attachments
    const gallerySection = document.getElementById('migration-hub-view-gallery-section');
    const attachmentsContainer = document.getElementById('migration-hub-view-attachments');
    const countEl = document.getElementById('migration-hub-view-attachments-count');

    const attachments = activePage.attachments || [];
    if (countEl) countEl.textContent = String(attachments.length);

    if (attachments.length === 0) {
      if (gallerySection) gallerySection.style.display = 'none';
    } else {
      if (gallerySection) gallerySection.style.display = 'block';
      if (attachmentsContainer) {
        let attachHtml = '';
        attachments.forEach((att) => {
          const sizeKb = Math.round(att.sizeBytes / 1024);
          attachHtml += `
            <div class="u-w-140px u-border-1px-solid-border-soft u-rounded-6px u-overflow-hidden u-bg-bg-1 u-cursor-pointer u-transition-transform-0_15s gm-wiki-thumbnail-card" data-full-url="${escapeHTML(att.url)}" title="Click to view screenshot">
              <img src="${escapeHTML(att.url)}" class="u-w-100pct u-h-95px u-fit-cover u-d-block" alt="${escapeHTML(att.name)}">
              <div class="u-p-0_35rem-0_5rem u-fs-0_7rem u-c-text-muted u-ws-nowrap u-overflow-hidden u-to-ellipsis">
                ${escapeHTML(att.name)} (${sizeKb} KB)
              </div>
            </div>
          `;
        });
        attachmentsContainer.innerHTML = attachHtml;

        // Wire lightbox on thumbnails
        attachmentsContainer.querySelectorAll('.gm-wiki-thumbnail-card').forEach((card) => {
          card.addEventListener('click', () => {
            const url = card.getAttribute('data-full-url');
            if (url) this.openLightbox(url);
          });
        });
      }
    }

    // Load and render comments for the active page
    const authorHint = document.getElementById('migration-hub-comment-author-hint');
    if (authorHint) {
      const currentG = getActiveGuild();
      const pseudo = getCurrentPseudo() || currentAccountId() || 'Leader';
      authorHint.textContent = `Posting as ${pseudo} [${currentG}]`;
    }
    this.loadComments(activePage.id);
  }

  /**
   * Starts creating a new page in the current scope.
   */
  public startNewPage(): void {
    this.editingPageId = null;
    this.pendingAttachments = [];

    const viewCard = document.getElementById('migration-hub-view-card');
    const editCard = document.getElementById('migration-hub-edit-card');
    if (!viewCard || !editCard) return;

    viewCard.style.display = 'none';
    editCard.style.display = 'block';

    const formTitle = document.getElementById('migration-hub-form-title');
    if (formTitle)
      formTitle.textContent = `New Page (${this.filterState.scope === 'guild' ? 'Guild Intel' : 'Server Intel'})`;

    const titleInput = document.getElementById('migration-hub-form-title-input') as HTMLInputElement | null;
    if (titleInput) titleInput.value = '';

    const catSelect = document.getElementById('migration-hub-form-category-select') as HTMLSelectElement | null;
    if (catSelect) catSelect.value = 'general';

    const pinnedCheck = document.getElementById('migration-hub-form-pinned-check') as HTMLInputElement | null;
    if (pinnedCheck) pinnedCheck.checked = false;

    const contentInput = document.getElementById('migration-hub-form-content-input') as HTMLTextAreaElement | null;
    if (contentInput) contentInput.value = '';

    this.renderPendingAttachments();
  }

  /**
   * Starts editing an existing page.
   */
  public startEditPage(pageId: string): void {
    const page = this.pages.find((p) => p.id === pageId);
    if (!page) return;

    this.editingPageId = pageId;
    this.pendingAttachments = Array.isArray(page.attachments) ? [...page.attachments] : [];

    const viewCard = document.getElementById('migration-hub-view-card');
    const editCard = document.getElementById('migration-hub-edit-card');
    if (!viewCard || !editCard) return;

    viewCard.style.display = 'none';
    editCard.style.display = 'block';

    const formTitle = document.getElementById('migration-hub-form-title');
    if (formTitle) formTitle.textContent = 'Edit Page';

    const titleInput = document.getElementById('migration-hub-form-title-input') as HTMLInputElement | null;
    if (titleInput) titleInput.value = page.title;

    const catSelect = document.getElementById('migration-hub-form-category-select') as HTMLSelectElement | null;
    if (catSelect) catSelect.value = page.category;

    const pinnedCheck = document.getElementById('migration-hub-form-pinned-check') as HTMLInputElement | null;
    if (pinnedCheck) pinnedCheck.checked = page.is_pinned;

    const contentInput = document.getElementById('migration-hub-form-content-input') as HTMLTextAreaElement | null;
    if (contentInput) contentInput.value = page.content;

    this.renderPendingAttachments();
  }

  /**
   * Cancels editing and returns to Read mode.
   */
  public cancelEditing(): void {
    this.editingPageId = null;
    this.pendingAttachments = [];

    const viewCard = document.getElementById('migration-hub-view-card');
    const editCard = document.getElementById('migration-hub-edit-card');
    if (viewCard && editCard) {
      viewCard.style.display = 'block';
      editCard.style.display = 'none';
    }
  }

  /**
   * Handles user submission of the wiki page form (create or update).
   */
  private async handleFormSubmit(): Promise<void> {
    const titleInput = document.getElementById('migration-hub-form-title-input') as HTMLInputElement | null;
    const catSelect = document.getElementById('migration-hub-form-category-select') as HTMLSelectElement | null;
    const pinnedCheck = document.getElementById('migration-hub-form-pinned-check') as HTMLInputElement | null;
    const contentInput = document.getElementById('migration-hub-form-content-input') as HTMLTextAreaElement | null;

    const title = (titleInput?.value || '').trim();
    if (!title) {
      showToast('Please provide a title for the page', 'error');
      return;
    }

    const category = (catSelect?.value || 'general') as MigrationWikiCategory;
    const isPinned = !!pinnedCheck?.checked;
    const content = (contentInput?.value || '').trim();

    const db = getClient();
    if (!db) return;

    const currentG = getActiveGuild();
    if (!currentG) return;
    const serverNumber = getServerNumber(currentG);
    const pseudo = getCurrentPseudo() || currentAccountId() || 'Admin';

    const saveBtn = document.getElementById('migration-hub-form-save-btn') as HTMLButtonElement | null;
    if (saveBtn) saveBtn.disabled = true;

    try {
      if (this.editingPageId) {
        // Update existing page
        const { error } = await updateWikiPage(
          db,
          this.editingPageId,
          title,
          category,
          content,
          isPinned,
          this.pendingAttachments
        );

        if (error) {
          console.error('[MigrationHub] Update failed', error);
          showToast('Failed to update page: ' + (error.message || 'Error'), 'error');
          return;
        }

        showToast('Page updated successfully!', 'success');
        this.filterState.activePageId = this.editingPageId;
      } else {
        // Create new page
        const { data, error } = await insertWikiPage(
          db,
          this.filterState.scope,
          serverNumber,
          currentG,
          category,
          title,
          content,
          isPinned,
          this.pendingAttachments,
          pseudo
        );

        if (error) {
          console.error('[MigrationHub] Insert failed', error);
          showToast('Failed to create page: ' + (error.message || 'Error'), 'error');
          return;
        }

        showToast('Page created successfully!', 'success');
        if (data && data.id) {
          this.filterState.activePageId = data.id;
        }
      }

      this.cancelEditing();
      await this.load();
    } catch (err: any) {
      console.error('[MigrationHub] handleFormSubmit exception', err);
      showToast('An unexpected error occurred while saving', 'error');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /**
   * Toggles the pinned status of the current page.
   */
  private async togglePinCurrentPage(): Promise<void> {
    const page = this.pages.find((p) => p.id === this.filterState.activePageId);
    if (!page) return;

    const db = getClient();
    if (!db) return;

    const newPinned = !page.is_pinned;
    const { error } = await setWikiPagePinned(db, page.id, newPinned);

    if (error) {
      showToast('Failed to pin/unpin page', 'error');
      return;
    }

    page.is_pinned = newPinned;
    showToast(newPinned ? 'Page pinned to top' : 'Page unpinned', 'info');
    this.renderPagesList();
    this.renderActivePage();
  }

  /**
   * Deletes the current page with confirmation.
   */
  private deleteCurrentPage(): void {
    const page = this.pages.find((p) => p.id === this.filterState.activePageId);
    if (!page) return;

    showConfirm(
      'Delete Page',
      // The confirm dialog renders HTML: the title is escaped, or a Server
      // Intel page titled by a rival guild's admin runs script in the session
      // of whoever clicks Delete.
      `Are you sure you want to delete "${escapeHTML(page.title)}"? This cannot be undone.`,
      async () => {
        const db = getClient();
        if (!db) return;

        // RLS filters a refused delete to zero rows without an error, so ask
        // for the deleted rows back and check one came.
        const { data, error } = await deleteWikiPage(db, page.id);
        if (error || !data || data.length === 0) {
          showToast(
            error
              ? 'Failed to delete page: ' + (error.message || 'Forbidden')
              : "Only the page's creator can delete it.",
            'error'
          );
          return;
        }

        showToast('Page deleted', 'info');
        this.filterState.activePageId = null;
        await this.load();
      }
    );
  }

  /**
   * Copies formatted page markdown for Discord.
   */
  private async exportCurrentPageToDiscord(): Promise<void> {
    const page = this.pages.find((p) => p.id === this.filterState.activePageId);
    if (!page) return;

    const cat = CATEGORY_LABELS[page.category] || page.category;
    const scopeLabel = page.scope === 'guild' ? `Guild [${page.guild_id}]` : `Server [${page.server_number}]`;

    const text = [
      `**[MIGRATION HUB] ${page.title}** (${cat.toUpperCase()})`,
      `*Scope: ${scopeLabel} | By: ${page.created_by_pseudo}*`,
      '---',
      page.content,
      page.attachments && page.attachments.length > 0 ? `\n*(${page.attachments.length} screenshot(s) attached)*` : '',
    ].join('\n');

    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied formatted text for Discord!', 'success');
    } catch {
      showToast('Failed to copy to clipboard', 'error');
    }
  }

  // --- Comments Thread System ---

  /**
   * Loads comments for a specific wiki page.
   */
  public async loadComments(pageId: string): Promise<void> {
    const db = getClient();
    if (!db) return;

    try {
      const { data, error } = await queryWikiComments(db, pageId);

      if (error) {
        console.error('[MigrationHub] Failed to fetch comments', error);
        return;
      }

      this.activeComments = (data || []) as MigrationWikiComment[];
      this.renderComments();
    } catch (err) {
      console.error('[MigrationHub] loadComments error', err);
    }
  }

  /**
   * Renders the comments list and counter in the UI.
   */
  private renderComments(): void {
    const listEl = document.getElementById('migration-hub-comments-list');
    const countEl = document.getElementById('migration-hub-comments-count');
    if (countEl) countEl.textContent = String(this.activeComments.length);
    if (!listEl) return;

    if (this.activeComments.length === 0) {
      listEl.innerHTML = `
        <div class="u-fs-0_8rem u-c-text-muted u-fst-italic u-p-0_5rem-0">
          No comments yet. Be the first leader to add intel.
        </div>
      `;
      return;
    }

    const currentAccId = currentAccountId();
    const isSuperAdmin = roleFromStorage() === 'super_admin';

    let html = '';
    this.activeComments.forEach((c) => {
      const dateStr = new Date(c.created_at).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      const canDelete = isSuperAdmin || (c.author_account_id && c.author_account_id === currentAccId);
      const guildBadge = c.author_guild_id
        ? `<span class="u-fs-0_68rem u-p-1px-5px gm-chip gm-chip-blue">[${escapeHTML(c.author_guild_id)}]</span>`
        : '';
      const roleLabel = c.author_role
        ? `<span class="u-fs-0_7rem u-c-text-muted">(${escapeHTML(c.author_role.replace('_', ' '))})</span>`
        : '';

      html += `
        <div class="u-p-0_75rem u-bg-bg-1 u-border-1px-solid-border-soft u-rounded-6px gm-card" data-comment-id="${escapeHTML(c.id)}">
          <div class="u-d-flex u-justify-space-between u-items-flex-start u-mb-0_4rem">
            <div class="u-d-flex u-items-center u-gap-0_4rem u-wrap-wrap">
              <div class="u-w-24px u-h-24px u-rounded-50pct u-bg-accent u-c-hexfff u-d-flex u-items-center u-justify-center u-fs-0_72rem u-fw-700">
                ${escapeHTML((c.author_pseudo || 'L').charAt(0).toUpperCase())}
              </div>
              <span class="u-fw-700 u-fs-0_85rem u-c-fg">${escapeHTML(c.author_pseudo)}</span>
              ${guildBadge}
              ${roleLabel}
              <span class="u-fs-0_72rem u-c-text-muted u-ml-0_25rem">· ${escapeHTML(dateStr)}</span>
            </div>
            ${
              canDelete
                ? `
              <button type="button" class="u-c-danger u-p-2px-6px u-fs-0_75rem gm-btn gm-btn-ghost gm-btn-sm btn-delete-comment" data-id="${escapeHTML(c.id)}" title="Delete comment">
                <i class="ph ph-trash"></i>
              </button>
            `
                : ''
            }
          </div>
          <div class="u-fs-0_85rem u-lh-1_5 u-c-text-normal u-ws-pre-wrap u-wb-break-word u-pl-1_8rem">${escapeHTML(c.content)}</div>
        </div>
      `;
    });

    listEl.innerHTML = html;

    listEl.querySelectorAll('.btn-delete-comment').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const cid = (e.currentTarget as HTMLElement).getAttribute('data-id');
        if (cid) this.deleteComment(cid);
      });
    });
  }

  /**
   * Submits a new comment on the currently active page.
   */
  private async handleCommentSubmit(): Promise<void> {
    const activePageId = this.filterState.activePageId;
    if (!activePageId) return;

    const input = document.getElementById('migration-hub-comment-input') as HTMLTextAreaElement | null;
    const submitBtn = document.getElementById('migration-hub-comment-submit-btn') as HTMLButtonElement | null;
    const content = (input?.value || '').trim();

    if (!content) {
      showToast('Please enter a comment', 'error');
      return;
    }

    const db = getClient();
    if (!db) return;

    const pseudo = getCurrentPseudo() || currentAccountId() || 'Leader';

    if (submitBtn) submitBtn.disabled = true;

    try {
      const { error } = await insertWikiComment(db, activePageId, content, pseudo);

      if (error) {
        console.error('[MigrationHub] Comment submit error', error);
        showToast('Failed to post comment: ' + (error.message || 'Error'), 'error');
        return;
      }

      if (input) input.value = '';
      showToast('Comment posted!', 'success');
      await this.loadComments(activePageId);
    } catch (err) {
      console.error('[MigrationHub] handleCommentSubmit error', err);
      showToast('Failed to submit comment', 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  /**
   * Deletes a comment with confirmation.
   */
  private async deleteComment(commentId: string): Promise<void> {
    showConfirm('Delete Comment', 'Are you sure you want to delete this comment?', async () => {
      const db = getClient();
      if (!db) return;

      const { error } = await deleteWikiComment(db, commentId);
      if (error) {
        console.error('[MigrationHub] delete comment error', error);
        showToast('Failed to delete comment: ' + (error.message || 'Forbidden'), 'error');
        return;
      }

      showToast('Comment deleted', 'info');
      if (this.filterState.activePageId) {
        await this.loadComments(this.filterState.activePageId);
      }
    });
  }

  /**
   * Compresses and attaches uploaded or pasted images.
   */
  private async handleFilesAdded(files: File[]): Promise<void> {
    if (files.length === 0) return;

    showToast(`Compressing ${files.length} screenshot(s)...`, 'info');

    for (const file of files) {
      try {
        const compressed = await compressImage(file, {
          maxWidth: 1440,
          maxHeight: 1440,
          quality: 0.78,
          preferredMimeType: 'image/webp',
        });

        const attachment: MigrationWikiAttachment = {
          id: Math.random().toString(36).substring(2, 11),
          url: compressed.dataUrl,
          name: file.name || 'screenshot.webp',
          sizeBytes: compressed.sizeBytes,
          width: compressed.width,
          height: compressed.height,
          createdAt: new Date().toISOString(),
        };

        this.pendingAttachments.push(attachment);
      } catch (err) {
        console.error('[MigrationHub] Compression error', err);
        showToast(`Failed to compress ${file.name}`, 'error');
      }
    }

    this.renderPendingAttachments();
  }

  /**
   * Renders the thumbnails of pending attachments in the form with a remove button.
   */
  private renderPendingAttachments(): void {
    const container = document.getElementById('migration-hub-pending-attachments');
    if (!container) return;

    if (this.pendingAttachments.length === 0) {
      container.innerHTML = '';
      return;
    }

    let html = '';
    this.pendingAttachments.forEach((att, idx) => {
      const sizeKb = Math.round(att.sizeBytes / 1024);
      html += `
        <div class="u-pos-relative u-w-100px u-h-80px u-rounded-6px u-overflow-hidden u-border-1px-solid-border-soft u-bg-bg-1">
          <img src="${escapeHTML(att.url)}" class="u-w-100pct u-h-100pct u-fit-cover" alt="preview">
          <button type="button" class="u-pos-absolute u-top-2px u-right-2px u-bg-rgba-0-0-0-0_7 u-border-none u-c-hexff4d4f u-rounded-50pct u-w-20px u-h-20px u-fs-12px u-cursor-pointer u-d-flex u-items-center u-justify-center gm-remove-att-btn" data-att-idx="${idx}" title="Remove screenshot">
            <i class="ph ph-x"></i>
          </button>
          <div class="u-pos-absolute u-bottom-0 u-left-0 u-right-0 u-bg-rgba-0-0-0-0_65 u-fs-9px u-c-hexfff u-text-center u-p-1px">
            ${sizeKb} KB
          </div>
        </div>
      `;
    });

    container.innerHTML = html;

    container.querySelectorAll('.gm-remove-att-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-att-idx'));
        if (!isNaN(idx)) {
          this.pendingAttachments.splice(idx, 1);
          this.renderPendingAttachments();
        }
      });
    });
  }

  /**
   * Applies formatting (h2, h3, bold, italic, list, quote, table) to the markdown textarea.
   */
  private applyMarkdownFormat(action: string): void {
    const textarea = document.getElementById('migration-hub-form-content-input') as HTMLTextAreaElement | null;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const selected = text.substring(start, end);

    let replacement = '';
    let cursorOffset = 0;

    switch (action) {
      case 'h2':
        replacement = `\n## ${selected || 'Section Title'}\n`;
        cursorOffset = replacement.length;
        break;
      case 'h3':
        replacement = `\n### ${selected || 'Subheading'}\n`;
        cursorOffset = replacement.length;
        break;
      case 'bold':
        replacement = `**${selected || 'bold text'}**`;
        cursorOffset = selected ? replacement.length : 2;
        break;
      case 'italic':
        replacement = `*${selected || 'italic text'}*`;
        cursorOffset = selected ? replacement.length : 1;
        break;
      case 'list':
        replacement = `\n- ${selected || 'Item 1'}\n- Item 2\n`;
        cursorOffset = replacement.length;
        break;
      case 'quote':
        replacement = `\n> ${selected || 'Quote text'}\n`;
        cursorOffset = replacement.length;
        break;
      case 'table':
        replacement = `\n| Player / Target | Server | Power | Status |\n| :--- | :---: | :---: | :--- |\n| PlayerName | 1089 | 150M | In Discussion |\n`;
        cursorOffset = replacement.length;
        break;
    }

    textarea.value = text.substring(0, start) + replacement + text.substring(end);
    textarea.focus();
    textarea.setSelectionRange(start + cursorOffset, start + cursorOffset);
  }

  /**
   * Opens the fullscreen lightbox for inspecting game screenshots.
   */
  private openLightbox(url: string): void {
    const lightbox = document.getElementById('migration-hub-lightbox');
    const img = document.getElementById('migration-hub-lightbox-img') as HTMLImageElement | null;
    if (lightbox && img) {
      img.src = url;
      lightbox.style.display = 'flex';
    }
  }

  /**
   * Securely converts markdown text to sanitized HTML.
   */
  public renderMarkdown(raw: string): string {
    if (!raw) return '';

    // Step 1: Sanitize all HTML special characters to prevent XSS
    let html = escapeHTML(raw);

    // Step 2: Headings
    html = html.replace(/^### (.*$)/gim, '<h3 class="u-m-1_1rem-0-0_4rem u-fs-1_05rem u-fw-700 u-c-fg">$1</h3>');
    html = html.replace(
      /^## (.*$)/gim,
      '<h2 class="u-m-1_3rem-0-0_5rem u-fs-1_22rem u-fw-700 u-c-fg u-bb-1px-solid-border-soft u-pb-0_25rem">$1</h2>'
    );
    html = html.replace(/^# (.*$)/gim, '<h1 class="u-m-1_5rem-0-0_6rem u-fs-1_4rem u-fw-700 u-c-fg">$1</h1>');

    // Step 3: Blockquotes
    html = html.replace(
      /^&gt; (.*$)/gim,
      '<blockquote class="u-bl-3px-solid-accent u-pl-0_75rem u-m-0_6rem-0 u-c-text-muted u-fst-italic">$1</blockquote>'
    );
    html = html.replace(
      /^> (.*$)/gim,
      '<blockquote class="u-bl-3px-solid-accent u-pl-0_75rem u-m-0_6rem-0 u-c-text-muted u-fst-italic">$1</blockquote>'
    );

    // Step 4: Tables
    // Simple markdown table parser for rows starting with |
    const lines = html.split('\n');
    let inTable = false;
    const processedLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('|') && line.endsWith('|')) {
        if (!inTable) {
          inTable = true;
          processedLines.push(
            '<table class="u-w-100pct u-bcol-collapse u-m-1rem-0 u-fs-0_85rem u-border-1px-solid-border-soft">'
          );
        }

        // Check if separator line (| :--- |)
        if (/^\|(\s*:?-+:?\s*\|)+$/.test(line)) {
          continue;
        }

        const cells = line.split('|').slice(1, -1);
        const isHeader = !processedLines.some((l) => l.includes('<tbody>'));

        if (isHeader) {
          processedLines.push('<thead class="u-bg-bg-1 u-bb-2px-solid-border-soft"><tr>');
          cells.forEach((c) =>
            processedLines.push(`<th class="u-p-0_5rem-0_75rem u-text-left u-fw-600">${c.trim()}</th>`)
          );
          processedLines.push('</tr></thead><tbody>');
        } else {
          processedLines.push('<tr class="u-bb-1px-solid-border-soft">');
          cells.forEach((c) => processedLines.push(`<td class="u-p-0_45rem-0_75rem">${c.trim()}</td>`));
          processedLines.push('</tr>');
        }
      } else {
        if (inTable) {
          processedLines.push('</tbody></table>');
          inTable = false;
        }
        processedLines.push(lines[i]);
      }
    }
    if (inTable) processedLines.push('</tbody></table>');
    html = processedLines.join('\n');

    // Step 5: Bold and Italic
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Step 6: Inline code (handles both raw and escaped backticks from escapeHTML)
    html = html.replace(
      /(?:`|&#96;)(.*?)(?:`|&#96;)/g,
      '<code class="u-bg-rgba-0-0-0-0_25 u-p-2px-5px u-rounded-4px u-ff-monospace u-fs-0_85em u-c-accent">$1</code>'
    );

    // Step 7: Bullet lists
    html = html.replace(/^- (.*$)/gim, '<li class="u-ml-1_25rem u-mb-0_25rem">$1</li>');

    // Step 8: Newlines to <br> (outside tables)
    html = html.replace(/\n\n/g, '<div class="u-mb-0_75rem"></div>');
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  /**
   * Generates a concise AI summary of the currently active page using Gemini.
   */
  public async generatePageSummary(): Promise<void> {
    const activePage = this.pages.find((p) => p.id === this.filterState.activePageId);
    if (!activePage) return;

    const aiBox = document.getElementById('migration-hub-page-ai-box');
    const aiContent = document.getElementById('migration-hub-page-ai-content');
    const summaryBtn = document.getElementById('migration-hub-ai-summary-btn') as HTMLButtonElement | null;

    if (!aiBox || !aiContent) return;

    aiBox.style.display = 'block';
    aiContent.innerHTML = `
      <div class="u-d-flex u-items-center u-gap-0_5rem u-c-text-muted u-fs-0_85rem">
        <i class="u-fs-1_1rem u-c-accent ph ph-spinner ph-spin"></i>
        <span>Analyzing note with Gemini AI...</span>
      </div>
    `;

    if (summaryBtn) {
      summaryBtn.disabled = true;
      summaryBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> <span>Summarizing...</span>';
    }

    try {
      const db = getClient();
      const { data, error } = await requestPageSummary(
        db,
        activePage.id,
        activePage.scope,
        activePage.guild_id,
        activePage.server_number
      );

      if (error || !data || !data.ok) {
        const errMsg = error?.message || data?.message || 'Failed to generate summary';
        aiContent.innerHTML = `<span class="u-c-danger"><i class="ph ph-warning"></i> ${escapeHTML(errMsg)}</span>`;
        showToast('AI summary failed: ' + errMsg, 'error');
        return;
      }

      this.currentAiSummary = data.summary || '';
      aiContent.innerHTML = this.renderMarkdown(this.currentAiSummary);
      showToast('AI summary generated!', 'success');
    } catch (err: any) {
      console.error('[MigrationHub] generatePageSummary exception', err);
      aiContent.innerHTML = `<span class="u-c-danger"><i class="ph ph-warning"></i> Error calling AI service</span>`;
      showToast('AI service error', 'error');
    } finally {
      if (summaryBtn) {
        summaryBtn.disabled = false;
        summaryBtn.innerHTML = '<i class="ph ph-sparkle"></i> <span>AI Summary</span>';
      }
    }
  }

  /**
   * Generates a synthesized executive briefing across all notes in the current scope using Gemini.
   */
  public async generateScopeBriefing(): Promise<void> {
    const modal = document.getElementById('migration-hub-ai-digest-modal');
    const modalTitle = document.getElementById('migration-hub-digest-modal-title');
    const modalContent = document.getElementById('migration-hub-digest-modal-content');
    const digestBtn = document.getElementById('migration-hub-ai-digest-btn') as HTMLButtonElement | null;

    if (!modal || !modalContent) return;

    const currentG = getActiveGuild();
    if (!currentG) return;
    const serverNumber = getServerNumber(currentG);
    const scopeLabel = this.filterState.scope === 'guild' ? `Guild [${currentG}]` : `Server [${serverNumber}]`;

    if (modalTitle) {
      modalTitle.textContent = `Executive Migration Briefing (${scopeLabel})`;
    }

    modal.style.display = 'flex';
    modalContent.innerHTML = `
      <div class="u-d-flex u-dir-column u-items-center u-justify-center u-p-3rem-1rem u-c-text-muted">
        <i class="u-fs-2_5rem u-c-accent u-mb-1rem ph ph-spinner ph-spin"></i>
        <div class="u-fw-600 u-fs-1rem u-c-fg u-mb-0_25rem">Synthesizing Migration Intelligence...</div>
        <div class="u-fs-0_82rem">Gemini AI is analyzing ${this.pages.length} active note(s) and agreement(s) for ${scopeLabel}.</div>
      </div>
    `;

    if (digestBtn) {
      digestBtn.disabled = true;
      digestBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> <span>Synthesizing...</span>';
    }

    try {
      const db = getClient();
      const { data, error } = await requestScopeBriefing(db, this.filterState.scope, currentG, serverNumber);

      if (error || !data || !data.ok) {
        const errMsg = error?.message || data?.message || 'Failed to generate briefing';
        modalContent.innerHTML = `
          <div class="u-p-1_5rem u-bg-rgba-239-68-68-0_1 u-border-1px-solid-rgba-239-68-68-0_3 u-rounded-8px u-c-danger">
            <i class="u-mr-0_35rem ph ph-warning"></i> ${escapeHTML(errMsg)}
          </div>
        `;
        showToast('Failed to generate briefing', 'error');
        return;
      }

      this.currentAiBriefing = data.summary || '';
      modalContent.innerHTML = this.renderMarkdown(this.currentAiBriefing);
      showToast('Executive briefing ready!', 'success');
    } catch (err: any) {
      console.error('[MigrationHub] generateScopeBriefing exception', err);
      modalContent.innerHTML = `
        <div class="u-p-1_5rem u-bg-rgba-239-68-68-0_1 u-border-1px-solid-rgba-239-68-68-0_3 u-rounded-8px u-c-danger">
          <i class="u-mr-0_35rem ph ph-warning"></i> Error communicating with Gemini AI service
        </div>
      `;
      showToast('AI service error', 'error');
    } finally {
      if (digestBtn) {
        digestBtn.disabled = false;
        digestBtn.innerHTML = '<i class="ph ph-sparkle"></i> <span>AI Digest</span>';
      }
    }
  }

  /**
   * Cleanup on view destruction.
   */
  public destroy(): void {
    const db = getClient();
    if (this.realtimeChannel) {
      if (db && typeof db.removeChannel === 'function') {
        db.removeChannel(this.realtimeChannel);
      }
      this.realtimeChannel = null;
    }
    if (this.commentsRealtimeChannel) {
      if (db && typeof db.removeChannel === 'function') {
        db.removeChannel(this.commentsRealtimeChannel);
      }
      this.commentsRealtimeChannel = null;
    }
    this.initialized = false;
  }
}

/** Shared singleton instance for Migration Hub. */
export const migrationHubView = new MigrationHubView();
