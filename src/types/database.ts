export type AccountRole = 'super_admin' | 'server_admin' | 'guild_admin' | 'member';

export interface GuildAccount {
  id: string;
  role: AccountRole;
  guild: string | null;
  server_number?: string | null;
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
  tech_power?: number;
  champion_power?: number;
  crew_power?: number;
  flagship_power?: number;
  fleet_rating?: number;
  glory_score?: number;
  metrics_updated_at?: string | null;
  timezone_offset?: number | null;
  power_updated_at?: string | null;
  role?: string | null;
  created_at?: string;
}

export interface PlayerMetricsHistory {
  id?: number;
  guild: string;
  pseudo: string;
  week_start: string;
  total_power: number;
  tech_power: number;
  champion_power: number;
  crew_power: number;
  flagship_power: number;
  fleet_rating: number;
  glory_score: number;
  created_at?: string;
}

export interface EventStatus {
  event_name: string;
  is_active: boolean;
  session_id: string;
  start_at: string | null;
  guild: string;
  stage?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface EventParticipant {
  id?: number;
  event_name: string;
  pseudo: string;
  guild: string;
  session_id: string;
  week_start?: string | null;
  participated?: number;
  score?: number | null;
  score_prep?: number | null;
  score_pvp?: number | null;
  sub_present?: boolean;
  excused?: boolean;
  late?: boolean;
  appointed?: boolean;
  is_pending?: boolean;
  created_at?: string;
}

export interface GuildSubscription {
  guild: string;
  type: 'Free' | 'Premium' | 'Unlimited' | 'Lifetime';
  end?: string | null;
  server_number?: number | null;
}

export interface SystemAuditLog {
  id?: string;
  created_at?: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  service: string;
  action_type?: string | null;
  pseudo?: string | null;
  uid?: string | null;
  server_number?: string | null;
  correlation_id?: string | null;
  guild?: string | null;
  user_identifier?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
  error_details?: Record<string, unknown> | null;
  duration_ms?: number | null;
}
