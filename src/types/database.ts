export type AccountRole = 'super_admin' | 'guild_admin' | 'member';

export interface GuildAccount {
  id: string;
  identifier: string;
  role: AccountRole;
  guild: string | null;
  status: 'active' | 'pending' | 'disabled';
  uid?: string | null;
  auth_user_id?: string | null;
  created_at: string;
}

export interface GuildMember {
  uid: string;
  pseudo: string;
  guild: string;
  overall_power: number;
  timezone_offset?: number | null;
  power_updated_at?: string | null;
  created_at?: string;
}

export interface EventStatus {
  event_name: string;
  active: boolean;
  session_id: string;
  start_at: string | null;
  guild: string;
  created_at?: string;
  updated_at?: string;
}

export interface EventParticipant {
  id?: number;
  event_name: string;
  pseudo: string;
  guild: string;
  session_id: string;
  score?: number | null;
  score_b?: number | null;
  sub_present?: boolean;
  excused?: boolean;
  late?: boolean;
  is_pending?: boolean;
  created_at?: string;
}

export interface GuildSubscription {
  guild: string;
  type: 'Free' | 'Premium' | 'Unlimited' | 'Lifetime';
  end?: string | null;
  server_number?: number | null;
}
