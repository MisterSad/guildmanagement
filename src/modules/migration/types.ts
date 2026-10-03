/**
 * src/modules/migration/types.ts
 *
 * Types and interfaces for the Migration Hub Wiki system.
 */

export type MigrationWikiScope = 'guild' | 'server';

export type MigrationWikiCategory =
  | 'general'
  | 'recruitment'
  | 'diplomacy'
  | 'blacklist'
  | 'strategy'
  | 'agreements';

export interface MigrationWikiAttachment {
  id: string;
  url: string; // Base64 data URL (compressed)
  name: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  createdAt: string;
}

export interface MigrationWikiPage {
  id: string;
  scope: MigrationWikiScope;
  server_number: string;
  guild_id: string | null;
  /** The guild that wrote the page; only it (or a super admin) edits or deletes it. */
  owner_guild: string | null;
  category: MigrationWikiCategory;
  title: string;
  content: string;
  is_pinned: boolean;
  attachments: MigrationWikiAttachment[];
  created_by_account_id: string | null;
  created_by_pseudo: string;
  updated_by_account_id: string | null;
  updated_by_pseudo: string;
  created_at: string;
  updated_at: string;
}

export interface MigrationHubFilterState {
  scope: MigrationWikiScope;
  category: string; // 'all' or MigrationWikiCategory
  searchQuery: string;
  activePageId: string | null;
}

export interface MigrationWikiComment {
  id: string;
  page_id: string;
  content: string;
  author_account_id: string | null;
  author_pseudo: string;
  author_guild_id: string | null;
  author_role: string;
  created_at: string;
  updated_at: string;
}
