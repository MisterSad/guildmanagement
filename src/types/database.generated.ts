export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_backup_codes: {
        Row: {
          account_id: string
          code_hash: string
          created_at: string
          id: string
          used_at: string | null
        }
        Insert: {
          account_id: string
          code_hash: string
          created_at?: string
          id?: string
          used_at?: string | null
        }
        Update: {
          account_id?: string
          code_hash?: string
          created_at?: string
          id?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_backup_codes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      account_link_codes: {
        Row: {
          account_id: string | null
          code_hash: string
          created_at: string
          expires_at: string
          guild: string | null
          id: string
          issued_by: string
          kind: string
          role: string | null
          used_at: string | null
          used_by_discord_user_id: string | null
        }
        Insert: {
          account_id?: string | null
          code_hash: string
          created_at?: string
          expires_at: string
          guild?: string | null
          id?: string
          issued_by: string
          kind: string
          role?: string | null
          used_at?: string | null
          used_by_discord_user_id?: string | null
        }
        Update: {
          account_id?: string | null
          code_hash?: string
          created_at?: string
          expires_at?: string
          guild?: string | null
          id?: string
          issued_by?: string
          kind?: string
          role?: string | null
          used_at?: string | null
          used_by_discord_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_link_codes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_link_codes_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      accounts: {
        Row: {
          auth_user_id: string | null
          created_at: string | null
          failed_login_count: number
          gotrue_secret_enc: string | null
          guild: string | null
          id: string
          last_login_at: string | null
          locked_until: string | null
          password_enc: string | null
          password_hash: string | null
          role: string | null
          server_number: string | null
          session_version: number
          status: string
          uid: string | null
        }
        Insert: {
          auth_user_id?: string | null
          created_at?: string | null
          failed_login_count?: number
          gotrue_secret_enc?: string | null
          guild?: string | null
          id: string
          last_login_at?: string | null
          locked_until?: string | null
          password_enc?: string | null
          password_hash?: string | null
          role?: string | null
          server_number?: string | null
          session_version?: number
          status?: string
          uid?: string | null
        }
        Update: {
          auth_user_id?: string | null
          created_at?: string | null
          failed_login_count?: number
          gotrue_secret_enc?: string | null
          guild?: string | null
          id?: string
          last_login_at?: string | null
          locked_until?: string | null
          password_enc?: string | null
          password_hash?: string | null
          role?: string | null
          server_number?: string | null
          session_version?: number
          status?: string
          uid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "accounts_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      banned_players: {
        Row: {
          created_at: string
          created_by: string | null
          guild: string
          id: number
          pseudo: string | null
          reason: string | null
          uid: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          guild: string
          id?: never
          pseudo?: string | null
          reason?: string | null
          uid: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          guild?: string
          id?: never
          pseudo?: string | null
          reason?: string | null
          uid?: string
        }
        Relationships: [
          {
            foreignKeyName: "banned_players_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      discord_account_links: {
        Row: {
          account_id: string
          discord_user_id: string
          linked_at: string
        }
        Insert: {
          account_id: string
          discord_user_id: string
          linked_at?: string
        }
        Update: {
          account_id?: string
          discord_user_id?: string
          linked_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "discord_account_links_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      discord_auth_throttle: {
        Row: {
          attempts: number
          discord_user_id: string
          window_start: string
        }
        Insert: {
          attempts?: number
          discord_user_id: string
          window_start: string
        }
        Update: {
          attempts?: number
          discord_user_id?: string
          window_start?: string
        }
        Relationships: []
      }
      discord_auth_tickets: {
        Row: {
          attempts: number
          created_at: string
          discord_user_id: string
          discord_username: string | null
          display_name: string | null
          expires_at: string
          ticket: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          discord_user_id: string
          discord_username?: string | null
          display_name?: string | null
          expires_at: string
          ticket: string
        }
        Update: {
          attempts?: number
          created_at?: string
          discord_user_id?: string
          discord_username?: string | null
          display_name?: string | null
          expires_at?: string
          ticket?: string
        }
        Relationships: []
      }
      discord_link_codes: {
        Row: {
          code: string
          created_at: string
          discord_user_id: string
          discord_username: string | null
          expires_at: string
        }
        Insert: {
          code: string
          created_at?: string
          discord_user_id: string
          discord_username?: string | null
          expires_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          discord_user_id?: string
          discord_username?: string | null
          expires_at?: string
        }
        Relationships: []
      }
      discord_oauth_states: {
        Row: {
          code_verifier: string
          created_at: string
          expires_at: string
          origin: string
          state: string
        }
        Insert: {
          code_verifier: string
          created_at?: string
          expires_at: string
          origin: string
          state: string
        }
        Update: {
          code_verifier?: string
          created_at?: string
          expires_at?: string
          origin?: string
          state?: string
        }
        Relationships: []
      }
      discord_rally_responses: {
        Row: {
          discord_user_id: string
          fleet: number
          message_id: string
          power: number
          pseudo: string
          status: string
          updated_at: string
        }
        Insert: {
          discord_user_id: string
          fleet?: number
          message_id: string
          power?: number
          pseudo: string
          status: string
          updated_at?: string
        }
        Update: {
          discord_user_id?: string
          fleet?: number
          message_id?: string
          power?: number
          pseudo?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      discord_verification_throttle: {
        Row: {
          attempts: number
          discord_user_id: string
          window_start: string
        }
        Insert: {
          attempts?: number
          discord_user_id: string
          window_start: string
        }
        Update: {
          attempts?: number
          discord_user_id?: string
          window_start?: string
        }
        Relationships: []
      }
      event_chest_tiers: {
        Row: {
          chests: number
          day: number
          event_name: string
          guild: string
          min_score: number
          tier: number
          updated_at: string
        }
        Insert: {
          chests?: number
          day: number
          event_name: string
          guild: string
          min_score: number
          tier: number
          updated_at?: string
        }
        Update: {
          chests?: number
          day?: number
          event_name?: string
          guild?: string
          min_score?: number
          tier?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_chest_tiers_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      event_daily_scores: {
        Row: {
          chests_unlocked: number
          day: number
          event_name: string
          guild: string
          id: number
          pseudo: string
          score: number
          session_id: string
          updated_at: string
        }
        Insert: {
          chests_unlocked?: number
          day: number
          event_name: string
          guild: string
          id?: number
          pseudo: string
          score?: number
          session_id: string
          updated_at?: string
        }
        Update: {
          chests_unlocked?: number
          day?: number
          event_name?: string
          guild?: string
          id?: number
          pseudo?: string
          score?: number
          session_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_daily_scores_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_event_daily_scores_member"
            columns: ["guild", "pseudo"]
            isOneToOne: false
            referencedRelation: "guild_members"
            referencedColumns: ["guild", "pseudo"]
          },
          {
            foreignKeyName: "fk_event_daily_scores_session"
            columns: ["guild", "event_name", "session_id"]
            isOneToOne: false
            referencedRelation: "war_sessions"
            referencedColumns: ["guild", "event_name", "session_id"]
          },
        ]
      }
      event_participants: {
        Row: {
          appointed: boolean | null
          created_at: string | null
          event_name: string
          excused: boolean | null
          guild: string
          id: number
          is_pending: boolean | null
          late: boolean | null
          participated: number
          pseudo: string
          score: number | null
          score_prep: number | null
          score_pvp: number | null
          session_id: string | null
          sub_present: boolean | null
          week_start: string
        }
        Insert: {
          appointed?: boolean | null
          created_at?: string | null
          event_name: string
          excused?: boolean | null
          guild: string
          id?: number
          is_pending?: boolean | null
          late?: boolean | null
          participated?: number
          pseudo: string
          score?: number | null
          score_prep?: number | null
          score_pvp?: number | null
          session_id?: string | null
          sub_present?: boolean | null
          week_start: string
        }
        Update: {
          appointed?: boolean | null
          created_at?: string | null
          event_name?: string
          excused?: boolean | null
          guild?: string
          id?: number
          is_pending?: boolean | null
          late?: boolean | null
          participated?: number
          pseudo?: string
          score?: number | null
          score_prep?: number | null
          score_pvp?: number | null
          session_id?: string | null
          sub_present?: boolean | null
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_participants_guild_pseudo_fkey"
            columns: ["guild", "pseudo"]
            isOneToOne: false
            referencedRelation: "guild_members"
            referencedColumns: ["guild", "pseudo"]
          },
        ]
      }
      event_status: {
        Row: {
          event_name: string
          guild: string
          id: number
          is_active: boolean
          session_id: string | null
          stage: string | null
          start_at: string | null
          updated_at: string
        }
        Insert: {
          event_name: string
          guild: string
          id?: number
          is_active?: boolean
          session_id?: string | null
          stage?: string | null
          start_at?: string | null
          updated_at?: string
        }
        Update: {
          event_name?: string
          guild?: string
          id?: number
          is_active?: boolean
          session_id?: string | null
          stage?: string | null
          start_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_status_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      guild_config: {
        Row: {
          guild: string
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          guild: string
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          guild?: string
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "guild_config_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      guild_creation_requests: {
        Row: {
          admin_id: string
          created_at: string
          discord_handle: string
          guild_tag: string
          id: string
          note: string | null
          reject_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          server_number: string
          status: string
        }
        Insert: {
          admin_id: string
          created_at?: string
          discord_handle: string
          guild_tag: string
          id?: string
          note?: string | null
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          server_number: string
          status?: string
        }
        Update: {
          admin_id?: string
          created_at?: string
          discord_handle?: string
          guild_tag?: string
          id?: string
          note?: string | null
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          server_number?: string
          status?: string
        }
        Relationships: []
      }
      guild_members: {
        Row: {
          champion_power: number | null
          created_at: string
          crew_power: number | null
          flagship_power: number | null
          fleet_rating: number | null
          glory_score: number | null
          guild: string
          id: number
          metrics_updated_at: string | null
          overall_power: number | null
          power_updated_at: string | null
          pseudo: string
          role: string | null
          tech_power: number | null
          timezone: string | null
          timezone_offset: number | null
          uid: string | null
        }
        Insert: {
          champion_power?: number | null
          created_at?: string
          crew_power?: number | null
          flagship_power?: number | null
          fleet_rating?: number | null
          glory_score?: number | null
          guild: string
          id?: number
          metrics_updated_at?: string | null
          overall_power?: number | null
          power_updated_at?: string | null
          pseudo: string
          role?: string | null
          tech_power?: number | null
          timezone?: string | null
          timezone_offset?: number | null
          uid?: string | null
        }
        Update: {
          champion_power?: number | null
          created_at?: string
          crew_power?: number | null
          flagship_power?: number | null
          fleet_rating?: number | null
          glory_score?: number | null
          guild?: string
          id?: number
          metrics_updated_at?: string | null
          overall_power?: number | null
          power_updated_at?: string | null
          pseudo?: string
          role?: string | null
          tech_power?: number | null
          timezone?: string | null
          timezone_offset?: number | null
          uid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "guild_members_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      guild_tag_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          guild: string
          id: number
          new_tag: string
          old_tag: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          guild: string
          id?: never
          new_tag: string
          old_tag: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          guild?: string
          id?: never
          new_tag?: string
          old_tag?: string
        }
        Relationships: [
          {
            foreignKeyName: "guild_tag_history_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      guild_transfers: {
        Row: {
          created_at: string | null
          id: string
          pseudo: string
          requested_by: string
          resolved_at: string | null
          resolved_by: string | null
          source_guild: string
          status: string
          target_guild: string
          uid: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          pseudo: string
          requested_by?: string
          resolved_at?: string | null
          resolved_by?: string | null
          source_guild: string
          status?: string
          target_guild: string
          uid: string
        }
        Update: {
          created_at?: string | null
          id?: string
          pseudo?: string
          requested_by?: string
          resolved_at?: string | null
          resolved_by?: string | null
          source_guild?: string
          status?: string
          target_guild?: string
          uid?: string
        }
        Relationships: [
          {
            foreignKeyName: "guild_transfers_source_guild_fkey"
            columns: ["source_guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guild_transfers_target_guild_fkey"
            columns: ["target_guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      guild_weekly_snapshots: {
        Row: {
          computed_at: string
          guild: string
          median_power: number | null
          opportunities: number
          pending_rows: number
          per_bucket: Json
          power_players: number
          present_members: number
          roster_size: number
          source: string
          week_start: string
        }
        Insert: {
          computed_at?: string
          guild: string
          median_power?: number | null
          opportunities?: number
          pending_rows?: number
          per_bucket?: Json
          power_players?: number
          present_members?: number
          roster_size?: number
          source?: string
          week_start: string
        }
        Update: {
          computed_at?: string
          guild?: string
          median_power?: number | null
          opportunities?: number
          pending_rows?: number
          per_bucket?: Json
          power_players?: number
          present_members?: number
          roster_size?: number
          source?: string
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "guild_weekly_snapshots_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      guilds: {
        Row: {
          created_at: string | null
          empty_since: string | null
          id: string
          server_number: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          empty_since?: string | null
          id: string
          server_number?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          empty_since?: string | null
          id?: string
          server_number?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      login_throttle: {
        Row: {
          attempts: number
          ip: string
          window_start: string
        }
        Insert: {
          attempts?: number
          ip: string
          window_start?: string
        }
        Update: {
          attempts?: number
          ip?: string
          window_start?: string
        }
        Relationships: []
      }
      migration_wiki_comments: {
        Row: {
          author_account_id: string | null
          author_guild_id: string | null
          author_pseudo: string
          author_role: string
          content: string
          created_at: string
          id: string
          page_id: string
          updated_at: string
        }
        Insert: {
          author_account_id?: string | null
          author_guild_id?: string | null
          author_pseudo: string
          author_role?: string
          content: string
          created_at?: string
          id?: string
          page_id: string
          updated_at?: string
        }
        Update: {
          author_account_id?: string | null
          author_guild_id?: string | null
          author_pseudo?: string
          author_role?: string
          content?: string
          created_at?: string
          id?: string
          page_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "migration_wiki_comments_author_account_id_fkey"
            columns: ["author_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "migration_wiki_comments_author_guild_id_fkey"
            columns: ["author_guild_id"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "migration_wiki_comments_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "migration_wiki_pages"
            referencedColumns: ["id"]
          },
        ]
      }
      migration_wiki_pages: {
        Row: {
          attachments: Json
          category: string
          content: string
          created_at: string
          created_by_account_id: string | null
          created_by_pseudo: string
          guild_id: string | null
          id: string
          is_pinned: boolean
          owner_guild: string | null
          scope: string
          server_number: string
          title: string
          updated_at: string
          updated_by_account_id: string | null
          updated_by_pseudo: string
        }
        Insert: {
          attachments?: Json
          category?: string
          content?: string
          created_at?: string
          created_by_account_id?: string | null
          created_by_pseudo: string
          guild_id?: string | null
          id?: string
          is_pinned?: boolean
          owner_guild?: string | null
          scope: string
          server_number: string
          title: string
          updated_at?: string
          updated_by_account_id?: string | null
          updated_by_pseudo: string
        }
        Update: {
          attachments?: Json
          category?: string
          content?: string
          created_at?: string
          created_by_account_id?: string | null
          created_by_pseudo?: string
          guild_id?: string | null
          id?: string
          is_pinned?: boolean
          owner_guild?: string | null
          scope?: string
          server_number?: string
          title?: string
          updated_at?: string
          updated_by_account_id?: string | null
          updated_by_pseudo?: string
        }
        Relationships: [
          {
            foreignKeyName: "migration_wiki_pages_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "migration_wiki_pages_guild_id_fkey"
            columns: ["guild_id"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "migration_wiki_pages_owner_guild_fkey"
            columns: ["owner_guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "migration_wiki_pages_updated_by_account_id_fkey"
            columns: ["updated_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      ocr_cache: {
        Row: {
          created_at: string
          ending_rank: string | null
          expires_at: string
          guild_id: string | null
          hash: string
          metric_type: string
          players: Json
        }
        Insert: {
          created_at?: string
          ending_rank?: string | null
          expires_at?: string
          guild_id?: string | null
          hash: string
          metric_type: string
          players: Json
        }
        Update: {
          created_at?: string
          ending_rank?: string | null
          expires_at?: string
          guild_id?: string | null
          hash?: string
          metric_type?: string
          players?: Json
        }
        Relationships: [
          {
            foreignKeyName: "ocr_cache_guild_id_fkey"
            columns: ["guild_id"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      player_absences: {
        Row: {
          created_at: string
          end_date: string
          guild: string
          id: string
          kind: string
          note: string | null
          pseudo: string
          start_date: string
          uid: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          end_date: string
          guild: string
          id?: string
          kind?: string
          note?: string | null
          pseudo: string
          start_date: string
          uid: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          end_date?: string
          guild?: string
          id?: string
          kind?: string
          note?: string | null
          pseudo?: string
          start_date?: string
          uid?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_absences_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      player_metrics_history: {
        Row: {
          champion_power: number | null
          created_at: string
          crew_power: number | null
          flagship_power: number | null
          fleet_rating: number | null
          glory_score: number | null
          guild: string
          id: number
          pseudo: string
          tech_power: number | null
          total_power: number | null
          week_start: string
        }
        Insert: {
          champion_power?: number | null
          created_at?: string
          crew_power?: number | null
          flagship_power?: number | null
          fleet_rating?: number | null
          glory_score?: number | null
          guild: string
          id?: number
          pseudo: string
          tech_power?: number | null
          total_power?: number | null
          week_start?: string
        }
        Update: {
          champion_power?: number | null
          created_at?: string
          crew_power?: number | null
          flagship_power?: number | null
          fleet_rating?: number | null
          glory_score?: number | null
          guild?: string
          id?: number
          pseudo?: string
          tech_power?: number | null
          total_power?: number | null
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_player_metrics_history_member"
            columns: ["guild", "pseudo"]
            isOneToOne: false
            referencedRelation: "guild_members"
            referencedColumns: ["guild", "pseudo"]
          },
          {
            foreignKeyName: "player_metrics_history_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      player_name_history: {
        Row: {
          changed_at: string | null
          changed_by: string
          guild: string
          id: string
          new_pseudo: string
          old_pseudo: string
          uid: string
        }
        Insert: {
          changed_at?: string | null
          changed_by: string
          guild: string
          id?: string
          new_pseudo: string
          old_pseudo: string
          uid: string
        }
        Update: {
          changed_at?: string | null
          changed_by?: string
          guild?: string
          id?: string
          new_pseudo?: string
          old_pseudo?: string
          uid?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_pnh_guild"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      sanctions: {
        Row: {
          comment: string | null
          created_at: string | null
          created_by: string | null
          guild: string
          id: string
          pseudo: string
        }
        Insert: {
          comment?: string | null
          created_at?: string | null
          created_by?: string | null
          guild: string
          id?: string
          pseudo: string
        }
        Update: {
          comment?: string | null
          created_at?: string | null
          created_by?: string | null
          guild?: string
          id?: string
          pseudo?: string
        }
        Relationships: [
          {
            foreignKeyName: "sanctions_guild_pseudo_fkey"
            columns: ["guild", "pseudo"]
            isOneToOne: false
            referencedRelation: "guild_members"
            referencedColumns: ["guild", "pseudo"]
          },
        ]
      }
      server_migration_group_servers: {
        Row: {
          added_at: string
          group_id: string
          id: number
          server_number: string
        }
        Insert: {
          added_at?: string
          group_id: string
          id?: number
          server_number: string
        }
        Update: {
          added_at?: string
          group_id?: string
          id?: number
          server_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "server_migration_group_servers_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "server_migration_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      server_migration_groups: {
        Row: {
          closed_at: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string
          opened_at: string
          status: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          opened_at?: string
          status?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          opened_at?: string
          status?: string
        }
        Relationships: []
      }
      shadowfront_signups: {
        Row: {
          availability: string
          guild: string
          id: string
          pseudo: string
          updated_at: string | null
          week_start: string
        }
        Insert: {
          availability: string
          guild: string
          id?: string
          pseudo: string
          updated_at?: string | null
          week_start: string
        }
        Update: {
          availability?: string
          guild?: string
          id?: string
          pseudo?: string
          updated_at?: string | null
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "shadowfront_signups_pseudo_fkey"
            columns: ["guild", "pseudo"]
            isOneToOne: false
            referencedRelation: "guild_members"
            referencedColumns: ["guild", "pseudo"]
          },
        ]
      }
      shadowfront_squads: {
        Row: {
          guild: string
          id: number
          is_commander: boolean | null
          pseudo: string
          role: string
          session_id: string | null
          squad: string
          week_start: string
        }
        Insert: {
          guild: string
          id?: number
          is_commander?: boolean | null
          pseudo: string
          role: string
          session_id?: string | null
          squad: string
          week_start: string
        }
        Update: {
          guild?: string
          id?: number
          is_commander?: boolean | null
          pseudo?: string
          role?: string
          session_id?: string | null
          squad?: string
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "shadowfront_squads_guild_pseudo_fkey"
            columns: ["guild", "pseudo"]
            isOneToOne: false
            referencedRelation: "guild_members"
            referencedColumns: ["guild", "pseudo"]
          },
        ]
      }
      system_audit_logs: {
        Row: {
          action_type: string | null
          correlation_id: string | null
          created_at: string
          duration_ms: number | null
          error_details: Json | null
          guild: string | null
          id: string
          level: string
          message: string
          metadata: Json | null
          pseudo: string | null
          server_number: string | null
          service: string
          uid: string | null
          user_identifier: string | null
        }
        Insert: {
          action_type?: string | null
          correlation_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_details?: Json | null
          guild?: string | null
          id?: string
          level: string
          message: string
          metadata?: Json | null
          pseudo?: string | null
          server_number?: string | null
          service: string
          uid?: string | null
          user_identifier?: string | null
        }
        Update: {
          action_type?: string | null
          correlation_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_details?: Json | null
          guild?: string | null
          id?: string
          level?: string
          message?: string
          metadata?: Json | null
          pseudo?: string | null
          server_number?: string | null
          service?: string
          uid?: string | null
          user_identifier?: string | null
        }
        Relationships: []
      }
      tickets: {
        Row: {
          attachments: Json | null
          category: string
          created_at: string
          description: string
          guild: string | null
          id: number
          reporter_account_id: string
          reporter_role: string
          resolved_at: string | null
          severity: string
          status: string
          ticket_number: number
          title: string
        }
        Insert: {
          attachments?: Json | null
          category?: string
          created_at?: string
          description: string
          guild?: string | null
          id?: number
          reporter_account_id: string
          reporter_role: string
          resolved_at?: string | null
          severity?: string
          status?: string
          ticket_number: number
          title: string
        }
        Update: {
          attachments?: Json | null
          category?: string
          created_at?: string
          description?: string
          guild?: string | null
          id?: number
          reporter_account_id?: string
          reporter_role?: string
          resolved_at?: string | null
          severity?: string
          status?: string
          ticket_number?: number
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "tickets_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      war_opponents: {
        Row: {
          created_at: string
          created_by: string | null
          guild: string
          guild_ref: string | null
          id: string
          kind: string
          name: string
          server_number: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          guild: string
          guild_ref?: string | null
          id?: string
          kind: string
          name: string
          server_number?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          guild?: string
          guild_ref?: string | null
          id?: string
          kind?: string
          name?: string
          server_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "war_opponents_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "war_opponents_guild_ref_fkey"
            columns: ["guild_ref"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
      war_sessions: {
        Row: {
          chest_tiers_snapshot: Json
          created_at: string
          day1_result: string | null
          day2_result: string | null
          day3_result: string | null
          day4_result: string | null
          day5_result: string | null
          day6_result: string | null
          event_name: string
          guild: string
          id: number
          opponent_id: string | null
          opponent_snapshot: Json
          session_id: string
          start_at: string | null
          updated_at: string
        }
        Insert: {
          chest_tiers_snapshot?: Json
          created_at?: string
          day1_result?: string | null
          day2_result?: string | null
          day3_result?: string | null
          day4_result?: string | null
          day5_result?: string | null
          day6_result?: string | null
          event_name: string
          guild: string
          id?: number
          opponent_id?: string | null
          opponent_snapshot?: Json
          session_id: string
          start_at?: string | null
          updated_at?: string
        }
        Update: {
          chest_tiers_snapshot?: Json
          created_at?: string
          day1_result?: string | null
          day2_result?: string | null
          day3_result?: string | null
          day4_result?: string | null
          day5_result?: string | null
          day6_result?: string | null
          event_name?: string
          guild?: string
          id?: number
          opponent_id?: string | null
          opponent_snapshot?: Json
          session_id?: string
          start_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "war_sessions_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "war_sessions_opponent_id_fkey"
            columns: ["opponent_id"]
            isOneToOne: false
            referencedRelation: "war_opponents"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_scores: {
        Row: {
          computed_at: string | null
          events_done: number | null
          events_total: number | null
          glory_score: number | null
          guild: string
          id: number
          pseudo: string
          score_20: number
          week_start: string
        }
        Insert: {
          computed_at?: string | null
          events_done?: number | null
          events_total?: number | null
          glory_score?: number | null
          guild: string
          id?: number
          pseudo: string
          score_20?: number
          week_start: string
        }
        Update: {
          computed_at?: string | null
          events_done?: number | null
          events_total?: number | null
          glory_score?: number | null
          guild?: string
          id?: number
          pseudo?: string
          score_20?: number
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_scores_guild_pseudo_fkey"
            columns: ["guild", "pseudo"]
            isOneToOne: false
            referencedRelation: "guild_members"
            referencedColumns: ["guild", "pseudo"]
          },
        ]
      }
    }
    Views: {
      gm_discord_claim_progress: {
        Row: {
          guild: string | null
          linked: number | null
          role: string | null
          total: number | null
          unlinked: number | null
        }
        Relationships: [
          {
            foreignKeyName: "accounts_guild_fkey"
            columns: ["guild"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      check_uid_exists_globally: { Args: { p_uid: string }; Returns: boolean }
      check_user_guild_access: { Args: { p_guild: string }; Returns: boolean }
      check_user_guild_write_access: {
        Args: { p_guild: string }
        Returns: boolean
      }
      gm_add_member: { Args: { p_guild: string; p_member: Json }; Returns: Json }
      gm_add_member_to_active_events: {
        Args: { p_guild: string; p_pseudo: string }
        Returns: number
      }
      gm_admin_delete: { Args: { p_id: string }; Returns: string }
      gm_admin_list: {
        Args: never
        Returns: {
          auth_user_id: string
          created_at: string
          guild: string
          id: string
          role: string
          server_number: string
          status: string
          uid: string
        }[]
      }
      gm_admin_request_transfer: {
        Args: { p_target_guild?: string; p_uid: string }
        Returns: Json
      }
      gm_admin_upsert: {
        Args: {
          p_guild: string
          p_id: string
          p_password: string
          p_role: string
        }
        Returns: undefined
      }
      gm_apply_data_retention: { Args: never; Returns: Json }
      gm_approve_guild_request: {
        Args: { p_request_id: string }
        Returns: Json
      }
      gm_approve_participant_submission: {
        Args: {
          p_event_name: string
          p_guild: string
          p_pseudo: string
          p_session_id: string
        }
        Returns: Json
      }
      gm_approve_player_account: { Args: { p_id: string }; Returns: Json }
      gm_attach_shadow: {
        Args: { p_auth_user_id: string; p_id: string; p_secret: string }
        Returns: undefined
      }
      gm_ban_member: {
        Args: { p_guild: string; p_pseudo: string; p_reason: string; p_uid: string }
        Returns: Json
      }
      gm_caller_guild: { Args: never; Returns: string }
      gm_can_access_server_wiki: {
        Args: { p_server_number: string }
        Returns: boolean
      }
      gm_can_access_wiki_page: { Args: { p_page_id: string }; Returns: boolean }
      gm_can_admin_see_absences: { Args: { p_guild: string }; Returns: boolean }
      gm_can_read_account: { Args: { p_account_id: string }; Returns: boolean }
      gm_can_read_guild_data: { Args: { p_guild: string }; Returns: boolean }
      gm_can_read_guilds: { Args: never; Returns: boolean }
      gm_check_discord_throttle: {
        Args: {
          p_bucket: string
          p_discord_user_id: string
          p_limit: number
          p_window_ms: number
        }
        Returns: {
          allowed: boolean
          remaining: number
        }[]
      }
      gm_check_ip_throttle: {
        Args: {
          p_bucket: string
          p_ip: string
          p_limit: number
          p_window_ms: number
        }
        Returns: {
          allowed: boolean
          remaining: number
        }[]
      }
      gm_check_login: {
        Args: { p_id: string; p_password: string }
        Returns: {
          canonical_id: string
          error: string
          is_locked: boolean
          role: string
          status: string
        }[]
      }
      gm_check_verification_throttle: {
        Args: {
          p_bucket: string
          p_discord_user_id: string
          p_limit: number
          p_window_ms: number
        }
        Returns: {
          allowed: boolean
          remaining: number
        }[]
      }
      gm_chests_for_score: {
        Args: { p_score: number; p_tiers: Json }
        Returns: number
      }
      gm_claim_account_with_discord: {
        Args: { p_discord_user_id: string; p_id: string; p_password: string }
        Returns: {
          account_id: string
          err: string
          ok: boolean
          role: string
        }[]
      }
      gm_cleanup_expired_ocr_cache: { Args: never; Returns: undefined }
      gm_cleanup_stale_reminder_locks: { Args: never; Returns: number }
      gm_clear_event_history: {
        Args: { p_event_names: string[]; p_guild: string }
        Returns: Json
      }
      gm_commit_ocr_roster: {
        Args: {
          p_existing: Json
          p_field: string
          p_guild: string
          p_new: Json
          p_removals: string[]
        }
        Returns: Json
      }
      gm_configured_webhooks: { Args: { p_guild: string }; Returns: string[] }
      gm_consume_discord_auth_ticket: {
        Args: { p_ticket: string }
        Returns: {
          attempts: number
          discord_user_id: string
          discord_username: string
          display_name: string
        }[]
      }
      gm_consume_discord_oauth_state: {
        Args: { p_state: string }
        Returns: {
          code_verifier: string
          origin: string
        }[]
      }
      gm_create_migration_group: {
        Args: { p_name: string; p_servers: string[] }
        Returns: Json
      }
      gm_create_ticket: {
        Args: {
          p_attachments?: Json
          p_category?: string
          p_description: string
          p_guild?: string
          p_reporter_account_id?: string
          p_reporter_role?: string
          p_severity?: string
          p_title: string
        }
        Returns: {
          id: number
          status: string
          ticket_number: number
        }[]
      }
      gm_delete_event_session: {
        Args: { p_event_name: string; p_guild: string; p_session_id: string }
        Returns: Json
      }
      gm_delete_guild: {
        Args: { p_guild_id: string }
        Returns: {
          error: string
          ok: boolean
        }[]
      }
      gm_delete_history_session: {
        Args: {
          p_event_name: string
          p_guild: string
          p_session_id: string
          p_week_start: string
        }
        Returns: Json
      }
      gm_delete_player_absence: {
        Args: { p_id: string; p_uid: string }
        Returns: Json
      }
      gm_delete_war_session: {
        Args: { p_event_name: string; p_guild: string; p_session_id: string }
        Returns: Json
      }
      gm_discord_create_guild: {
        Args: {
          p_discord_user_id: string
          p_discord_username: string
          p_guild_tag: string
          p_server_number: string
        }
        Returns: {
          account_id: string
          err: string
          guild: string
          ok: boolean
          role: string
        }[]
      }
      gm_discord_join_guild: {
        Args: {
          p_discord_user_id: string
          p_discord_username: string
          p_join_code: string
          p_uid: string
        }
        Returns: {
          account_id: string
          err: string
          guild: string
          ok: boolean
          role: string
          status: string
        }[]
      }
      gm_discord_unlink: {
        Args: {
          p_account_id: string
          p_actor: string
          p_code_hash: string
          p_expires_at: string
        }
        Returns: {
          err: string
          guild: string
          ok: boolean
          previous_discord_user_id: string
        }[]
      }
      gm_erase_account: { Args: { p_account_id: string }; Returns: Json }
      gm_erase_player: {
        Args: { p_guild: string; p_uid: string }
        Returns: Json
      }
      gm_event_scoring_key:
        | {
            Args: {
              p_event_name: string
              p_session_id: string
              p_week_start: string
            }
            Returns: string
          }
        | {
            Args: {
              p_event_name: string
              p_session_id: string
              p_week_start: string
            }
            Returns: string
          }
      gm_expire_empty_guilds: { Args: never; Returns: Json }
      gm_find_player_by_uid: { Args: { p_uid: string }; Returns: Json }
      gm_generate_account_id: { Args: { p_base: string }; Returns: string }
      gm_get_chest_tiers: {
        Args: { p_event_name: string; p_guild: string }
        Returns: Json
      }
      gm_get_daily_scores: {
        Args: { p_event_name: string; p_guild: string; p_session_id: string }
        Returns: Json
      }
      gm_get_join_code: { Args: { p_guild: string }; Returns: Json }
      gm_get_player_absences: {
        Args: { p_uid: string }
        Returns: {
          created_at: string
          end_date: string
          guild: string
          id: string
          kind: string
          note: string
          pseudo: string
          start_date: string
        }[]
      }
      gm_get_player_event_history: {
        Args: { p_limit?: number; p_uid: string }
        Returns: Json
      }
      gm_get_player_metrics_history: {
        Args: { p_limit?: number; p_uid: string }
        Returns: Json
      }
      gm_get_shadow: {
        Args: { p_id: string }
        Returns: {
          auth_user_id: string
          gotrue_secret: string
        }[]
      }
      gm_get_war_session: {
        Args: { p_event_name: string; p_guild: string; p_session_id: string }
        Returns: Json
      }
      gm_guild_tag_history: { Args: { p_guild: string }; Returns: Json }
      gm_invoke_event_reminders: { Args: never; Returns: undefined }
      gm_is_admin_caller: { Args: never; Returns: boolean }
      gm_is_webhook_key: { Args: { p_key: string }; Returns: boolean }
      gm_issue_admin_invite: {
        Args: {
          p_code_hash: string
          p_expires_at: string
          p_guild: string
          p_issued_by: string
          p_max_open: number
          p_role: string
        }
        Returns: {
          err: string
          ok: boolean
          open_codes: number
        }[]
      }
      gm_latest_glory_scores: {
        Args: { p_guild: string }
        Returns: {
          pseudo: string
          score: number
        }[]
      }
      gm_list_event_sessions: {
        Args: { p_guild?: string }
        Returns: {
          display_name: string
          event_name: string
          granular: boolean
          participants: number
          participated_count: number
          session_id: string
          start_at: string
          total_score: number
          week_start: string
        }[]
      }
      gm_list_opponent_candidates: {
        Args: { p_guild: string; p_kind: string }
        Returns: Json
      }
      gm_list_tickets: {
        Args: never
        Returns: {
          attachments: Json
          category: string
          created_at: string
          description: string
          guild: string
          id: number
          reporter_account_id: string
          reporter_role: string
          resolved_at: string
          severity: string
          status: string
          ticket_number: number
          title: string
        }[]
      }
      gm_list_transfer_eligible_guilds: {
        Args: { p_guild: string }
        Returns: {
          id: string
          is_same_server: boolean
          server_number: string
        }[]
      }
      gm_list_war_sessions: {
        Args: { p_event_name: string; p_guild: string }
        Returns: Json
      }
      gm_log_player_audit: {
        Args: {
          p_action_type: string
          p_guild: string
          p_level?: string
          p_message?: string
          p_metadata?: Json
          p_pseudo: string
          p_server_number?: string
          p_service?: string
          p_uid: string
        }
        Returns: string
      }
      gm_personal_kpis: { Args: { p_uid: string }; Returns: Json }
      gm_player_session_guild_stats: {
        Args: { p_guild: string; p_pseudo: string }
        Returns: {
          counted: number
          max_score: number
          session_key: string
          total_score: number
        }[]
      }
      gm_player_stats: {
        Args: { p_guild: string; p_pseudo: string; p_weeks?: number }
        Returns: Json
      }
      gm_populate_event_participants: {
        Args: {
          p_event_name: string
          p_guild: string
          p_session_id: string
          p_week_start: string
        }
        Returns: number
      }
      gm_purge_cron_history: { Args: never; Returns: number }
      gm_purge_discord_ephemera: { Args: never; Returns: Json }
      gm_purge_guild_data: { Args: { p_guild: string }; Returns: Json }
      gm_record_event_attendance: {
        Args: {
          p_event_name: string
          p_guild: string
          p_rows: Json
          p_session_id: string
          p_week_start: string
        }
        Returns: Json
      }
      gm_redeem_admin_invite: {
        Args: {
          p_code_hash: string
          p_discord_user_id: string
          p_discord_username: string
        }
        Returns: {
          account_id: string
          err: string
          guild: string
          ok: boolean
          role: string
        }[]
      }
      gm_redeem_relink_code: {
        Args: { p_code_hash: string; p_discord_user_id: string }
        Returns: {
          account_id: string
          err: string
          ok: boolean
          role: string
        }[]
      }
      gm_register_player: {
        Args: {
          p_id: string
          p_join_code: string
          p_password: string
          p_uid: string
        }
        Returns: Json
      }
      gm_reject_guild_request: {
        Args: { p_reason: string; p_request_id: string }
        Returns: Json
      }
      gm_reject_player_account: { Args: { p_id: string }; Returns: Json }
      gm_rename_guild: {
        Args: { p_guild: string; p_new_tag: string }
        Returns: Json
      }
      gm_report_client_error: {
        Args: {
          p_correlation_id: string
          p_error_details?: Json
          p_guild?: string
          p_level: string
          p_message?: string
          p_metadata?: Json
          p_service: string
          p_user_identifier?: string
        }
        Returns: boolean
      }
      gm_require_guild_write: { Args: { p_guild: string }; Returns: string }
      gm_reschedule_event_session: {
        Args: {
          p_event_name: string
          p_guild: string
          p_new_session_id: string
          p_old_session_id: string
          p_start_at: string
        }
        Returns: Json
      }
      gm_reset_account_password: {
        Args: { p_id: string; p_password: string }
        Returns: {
          error: string
          ok: boolean
        }[]
      }
      gm_revoke_auth_sessions: {
        Args: { p_auth_user_id: string }
        Returns: number
      }
      gm_save_chest_tiers: {
        Args: { p_event_name: string; p_guild: string; p_tiers: Json }
        Returns: Json
      }
      gm_session_is_valid: { Args: never; Returns: boolean }
      gm_set_join_code: {
        Args: { p_code: string; p_guild: string }
        Returns: Json
      }
      gm_snowflake_created_at: {
        Args: { p_snowflake: string }
        Returns: string
      }
      gm_stats_events: {
        Args: { p_bucket: string; p_guild: string; p_weeks?: string[] }
        Returns: Json
      }
      gm_stats_health: {
        Args: { p_guild: string; p_weeks?: number }
        Returns: Json
      }
      gm_stats_members: {
        Args: { p_guild: string; p_trend?: boolean; p_weeks?: string[] }
        Returns: Json
      }
      gm_stats_snapshot_run: { Args: never; Returns: number }
      gm_stats_snapshot_upsert: {
        Args: { p_guild: string; p_source?: string; p_week_start: string }
        Returns: boolean
      }
      gm_stats_weeks: { Args: { p_guild?: string }; Returns: Json }
      gm_submit_guild_request: {
        Args: {
          p_admin_id: string
          p_discord_handle: string
          p_guild_tag: string
          p_note: string
          p_server_number: string
        }
        Returns: Json
      }
      gm_sync_shadowfront_participants: {
        Args: { p_guild: string; p_session_id: string }
        Returns: number
      }
      gm_transfer_guild_member: {
        Args: { p_pseudo?: string; p_target_guild: string; p_uid: string }
        Returns: Json
      }
      gm_transfer_sync_related_rows: {
        Args: {
          p_pseudo: string
          p_source_guild: string
          p_target_guild: string
        }
        Returns: undefined
      }
      gm_unsync_shadowfront_participant: {
        Args: { p_guild: string; p_pseudo: string; p_session_id: string }
        Returns: {
          error: string
          ok: boolean
        }[]
      }
      gm_update_account_role: {
        Args: {
          p_guild?: string
          p_id: string
          p_role: string
          p_server_number?: string
        }
        Returns: {
          error: string
          ok: boolean
          role: string
          server_number: string
        }[]
      }
      gm_update_member: {
        Args: { p_guild: string; p_pseudo: string; p_update: Json }
        Returns: Json
      }
      gm_update_player_timezone: {
        Args: { p_offset: number; p_timezone?: string; p_uid: string }
        Returns: Json
      }
      gm_update_ticket_status: {
        Args: { p_id: number; p_status: string }
        Returns: {
          category: string
          error: string
          guild: string
          new_status: string
          ok: boolean
          old_status: string
          reporter_account_id: string
          severity: string
          ticket_number: number
          title: string
        }[]
      }
      gm_upsert_daily_scores: {
        Args: {
          p_event_name: string
          p_guild: string
          p_rows: Json
          p_session_id: string
        }
        Returns: Json
      }
      gm_upsert_player_absence: {
        Args: {
          p_end_date: string
          p_guild: string
          p_id: string
          p_kind: string
          p_note: string
          p_pseudo: string
          p_start_date: string
          p_uid: string
        }
        Returns: Json
      }
      gm_upsert_player_glory: {
        Args: {
          p_glory: number
          p_guild: string
          p_pseudo: string
          p_week_start: string
        }
        Returns: {
          error: string
          ok: boolean
        }[]
      }
      gm_upsert_player_metrics: {
        Args: {
          p_champion_power?: number
          p_crew_power?: number
          p_flagship_power?: number
          p_fleet_rating?: number
          p_glory_score?: number
          p_guild: string
          p_pseudo: string
          p_tech_power?: number
          p_total_power?: number
        }
        Returns: Json
      }
      gm_upsert_war_session: {
        Args: {
          p_daily_results?: Json
          p_event_name: string
          p_guild: string
          p_opponent?: Json
          p_session_id: string
          p_start_at?: string
        }
        Returns: Json
      }
      gm_verify_password: {
        Args: { p_id: string; p_password: string }
        Returns: {
          canonical_id: string
          error: string
          is_locked: boolean
          role: string
          status: string
        }[]
      }
      is_server_admin: { Args: never; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
      request_guild_transfer: {
        Args: { p_target_guild: string; p_uid: string }
        Returns: Json
      }
      resolve_guild_transfer: {
        Args: { p_action: string; p_transfer_id: string }
        Returns: Json
      }
      servers_in_open_migration_group: {
        Args: { p_server_a: string; p_server_b: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
