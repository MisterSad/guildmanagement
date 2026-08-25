/**
 * src/modules/leader-hall/leader-hall.service.ts — TypeScript Leader Hall Service
 * FGF Guild Management Tool — 2026 Zero-Trust Architecture
 */

import { getSupabaseClient } from '../../core/api/supabase';

export interface LeaderConversation {
  id: string;
  type: 'direct' | 'group';
  title?: string | null;
  createdBy: string;
  isR5Only: boolean;
  serverNumber?: string | null;
  updatedAt: string;
  members: Array<{
    account_id: string;
    guild?: string | null;
    role: string;
    group_role: 'admin' | 'member';
  }>;
}

export class LeaderHallService {
  private static instance: LeaderHallService;

  private constructor() {}

  public static getInstance(): LeaderHallService {
    if (!LeaderHallService.instance) {
      LeaderHallService.instance = new LeaderHallService();
    }
    return LeaderHallService.instance;
  }

  public async fetchConversations(accountId: string): Promise<LeaderConversation[]> {
    const supabase = getSupabaseClient();
    if (!supabase) return [];

    const { data, error } = await supabase
      .from('e2ee_conversation_members')
      .select('conversation_id, group_role, e2ee_conversations (id, type, title, created_by, is_r5_only, server_number, updated_at)')
      .eq('account_id', accountId)
      .order('conversation_id', { ascending: false });

    if (error || !data) return [];

    const conversations: LeaderConversation[] = [];
    for (const row of data as any[]) {
      const c = row.e2ee_conversations;
      if (!c) continue;

      const { data: members } = await supabase
        .from('e2ee_conversation_members')
        .select('account_id, guild, role, group_role')
        .eq('conversation_id', c.id);

      conversations.push({
        id: c.id,
        type: c.type,
        title: c.title,
        createdBy: c.created_by,
        isR5Only: c.is_r5_only,
        serverNumber: c.server_number,
        updatedAt: c.updated_at,
        members: (members as any) || []
      });
    }

    return conversations;
  }
}
