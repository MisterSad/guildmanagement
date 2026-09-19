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
