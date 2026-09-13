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
          status?: string
          uid?: string | null
        }
        Relationships: []
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
        Relationships: []
      }
      diplomatic_treaties: {
        Row: {
          created_at: string
          created_by_account_id: string
          expires_at: string | null
          guild_a: string
          guild_a_server: string
          guild_a_signed_at: string | null
          guild_a_signed_by: string | null
          guild_b: string
          guild_b_server: string
          guild_b_signed_at: string | null
          guild_b_signed_by: string | null
          id: string
          status: string
          terms: string
          title: string
          treaty_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_account_id: string
          expires_at?: string | null
          guild_a: string
          guild_a_server: string
          guild_a_signed_at?: string | null
          guild_a_signed_by?: string | null
          guild_b: string
          guild_b_server: string
          guild_b_signed_at?: string | null
          guild_b_signed_by?: string | null
          id?: string
          status?: string
          terms: string
          title: string
          treaty_type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_account_id?: string
          expires_at?: string | null
          guild_a?: string
          guild_a_server?: string
          guild_a_signed_at?: string | null
          guild_a_signed_by?: string | null
          guild_b?: string
          guild_b_server?: string
          guild_b_signed_at?: string | null
          guild_b_signed_by?: string | null
          id?: string
          status?: string
          terms?: string
          title?: string
          treaty_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "diplomatic_treaties_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "diplomatic_treaties_guild_a_fkey"
            columns: ["guild_a"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "diplomatic_treaties_guild_a_signed_by_fkey"
            columns: ["guild_a_signed_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "diplomatic_treaties_guild_b_fkey"
            columns: ["guild_b"]
            isOneToOne: false
            referencedRelation: "guilds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "diplomatic_treaties_guild_b_signed_by_fkey"
            columns: ["guild_b_signed_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      e2ee_blocked_accounts: {
        Row: {
          account_id: string
          blocked_account_id: string
          created_at: string
        }
        Insert: {
          account_id: string
          blocked_account_id: string
          created_at?: string
        }
        Update: {
          account_id?: string
          blocked_account_id?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "e2ee_blocked_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e2ee_blocked_accounts_blocked_account_id_fkey"
            columns: ["blocked_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      e2ee_conversation_members: {
        Row: {
          account_id: string
          conversation_id: string
          group_role: string
          guild: string | null
          joined_at: string
          role: string
        }
        Insert: {
          account_id: string
          conversation_id: string
          group_role?: string
          guild?: string | null
          joined_at?: string
          role: string
        }
        Update: {
          account_id?: string
          conversation_id?: string
          group_role?: string
          guild?: string | null
          joined_at?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "e2ee_conversation_members_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e2ee_conversation_members_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "e2ee_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      e2ee_conversations: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          is_r5_only: boolean
          server_number: string | null
          title: string | null
          type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_r5_only?: boolean
          server_number?: string | null
          title?: string | null
          type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_r5_only?: boolean
          server_number?: string | null
          title?: string | null
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "e2ee_conversations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      e2ee_message_reactions: {
        Row: {
          account_id: string
          conversation_id: string
          created_at: string
          emoji: string
          id: number
          message_id: number
        }
        Insert: {
          account_id: string
          conversation_id: string
          created_at?: string
          emoji: string
          id?: number
          message_id: number
        }
        Update: {
          account_id?: string
          conversation_id?: string
          created_at?: string
          emoji?: string
          id?: number
          message_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "e2ee_message_reactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e2ee_message_reactions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "e2ee_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e2ee_message_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "e2ee_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      e2ee_messages: {
        Row: {
          ciphertext: string
          conversation_id: string
          created_at: string
          header_data: Json
          id: number
          iv: string
          sender_account_id: string
          sender_guild: string | null
          sender_role: string
        }
        Insert: {
          ciphertext: string
          conversation_id: string
          created_at?: string
          header_data?: Json
          id?: number
          iv: string
          sender_account_id: string
          sender_guild?: string | null
          sender_role: string
        }
        Update: {
          ciphertext?: string
          conversation_id?: string
          created_at?: string
          header_data?: Json
          id?: number
          iv?: string
          sender_account_id?: string
          sender_guild?: string | null
          sender_role?: string
        }
        Relationships: [
          {
            foreignKeyName: "e2ee_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "e2ee_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "e2ee_messages_sender_account_id_fkey"
            columns: ["sender_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      e2ee_one_time_prekeys: {
        Row: {
          account_id: string
          created_at: string
          id: number
          is_used: boolean
          key_id: number
          public_key: string
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: number
          is_used?: boolean
          key_id: number
          public_key: string
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: number
          is_used?: boolean
          key_id?: number
          public_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "e2ee_one_time_prekeys_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      e2ee_prekey_bundles: {
        Row: {
          account_id: string
          identity_key: string
          identity_signing_key: string | null
          registration_id: number
          signed_prekey: string
          signed_prekey_sig: string
          updated_at: string
        }
        Insert: {
          account_id: string
          identity_key: string
          identity_signing_key?: string | null
          registration_id: number
          signed_prekey: string
          signed_prekey_sig: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          identity_key?: string
          identity_signing_key?: string | null
          registration_id?: number
          signed_prekey?: string
          signed_prekey_sig?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "e2ee_prekey_bundles_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
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
          chests: number
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
        Relationships: []
      }
      gm_payments: {
        Row: {
          amount_cents: number
          applied_at: string | null
          created_at: string
          currency: string
          days_added: number | null
          guild_id: string
          id: string
          kind: string
          merchant_order_ext_ref: string | null
          order_id: string | null
          plan_key: string
          provider: string
          status: string
          token: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          applied_at?: string | null
          created_at?: string
          currency?: string
          days_added?: number | null
          guild_id: string
          id?: string
          kind?: string
          merchant_order_ext_ref?: string | null
          order_id?: string | null
          plan_key: string
          provider?: string
          status?: string
          token?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          applied_at?: string | null
          created_at?: string
          currency?: string
          days_added?: number | null
          guild_id?: string
          id?: string
          kind?: string
          merchant_order_ext_ref?: string | null
          order_id?: string | null
          plan_key?: string
          provider?: string
          status?: string
          token?: string | null
          updated_at?: string
        }
        Relationships: []
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
          timezone_offset?: number | null
          uid?: string | null
        }
        Relationships: []
      }
      guild_transfers: {
        Row: {
          created_at: string | null
          id: string
          pseudo: string
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
      guilds: {
        Row: {
          created_at: string | null
          id: string
          payments_disabled: boolean
          plan_key: string | null
          server_number: string | null
          subscription_end: string | null
          subscription_type: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id: string
          payments_disabled?: boolean
          plan_key?: string | null
          server_number?: string | null
          subscription_end?: string | null
          subscription_type?: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          payments_disabled?: boolean
          plan_key?: string | null
          server_number?: string | null
          subscription_end?: string | null
          subscription_type?: string
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
        Relationships: []
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
      player_push_prefs: {
        Row: {
          event_types: string[]
          guild: string
          pseudo: string
          updated_at: string
        }
        Insert: {
          event_types?: string[]
          guild: string
          pseudo: string
          updated_at?: string
        }
        Update: {
          event_types?: string[]
          guild?: string
          pseudo?: string
          updated_at?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          guild: string
          id: number
          last_seen: string
          p256dh: string
          pseudo: string | null
          ua: string | null
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          guild: string
          id?: never
          last_seen?: string
          p256dh: string
          pseudo?: string | null
          ua?: string | null
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          guild?: string
          id?: never
          last_seen?: string
          p256dh?: string
          pseudo?: string | null
          ua?: string | null
        }
        Relationships: []
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
      [_ in never]: never
    }
    Functions: {
      check_uid_exists_globally: { Args: { p_uid: string }; Returns: boolean }
      check_user_guild_access: { Args: { p_guild: string }; Returns: boolean }
      check_user_guild_write_access: {
        Args: { p_guild: string }
        Returns: boolean
      }
      get_push_config: {
        Args: never
        Returns: {
          cron_secret: string
          vapid_private: string
          vapid_public: string
          vapid_subject: string
        }[]
      }
      gm_add_e2ee_group_member: {
        Args: { p_account_ids: string[]; p_conversation_id: string }
        Returns: boolean
      }
      gm_add_e2ee_group_members: {
        Args: { p_account_ids: string[]; p_conversation_id: string }
        Returns: boolean
      }
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
      gm_apply_donation: {
        Args: { p_order_id: string }
        Returns: {
          amount_cents: number
          error: string
          guild_id: string
          ok: boolean
          payment_id: string
        }[]
      }
      gm_apply_subscription_payment: {
        Args: {
          p_ext_ref?: string
          p_order_id: string
          p_provider?: string
          p_token?: string
        }
        Returns: {
          days_added: number
          error: string
          guild_id: string
          ok: boolean
          plan_key: string
        }[]
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
      gm_can_access_e2ee_conversation: {
        Args: { p_conversation_id: string }
        Returns: boolean
      }
      gm_can_admin_see_absences: { Args: { p_guild: string }; Returns: boolean }
      gm_can_read_account: { Args: { p_account_id: string }; Returns: boolean }
      gm_can_read_guild_data: { Args: { p_guild: string }; Returns: boolean }
      gm_can_read_guilds: { Args: never; Returns: boolean }
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
      gm_chests_for_score: {
        Args: { p_score: number; p_tiers?: Json }
        Returns: number
      }
      gm_cleanup_stale_reminder_locks: { Args: never; Returns: number }
      gm_create_diplomatic_treaty: {
        Args: {
          p_expires_days?: number
          p_guild_b: string
          p_guild_b_server: string
          p_terms: string
          p_treaty_type: string
        }
        Returns: string
      }
      gm_create_e2ee_conversation: {
        Args: {
          p_is_r5_only?: boolean
          p_member_account_ids?: string[]
          p_title?: string
          p_type: string
        }
        Returns: string
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
      gm_cross_guild_ranking: {
        Args: never
        Returns: {
          arms_attended: number
          arms_rate: number
          arms_total: number
          day6_pvp_score: number
          day6_score: number
          draft_score: number
          dtr_attended: number
          dtr_rate: number
          dtr_total: number
          global_attended: number
          global_rate: number
          global_total: number
          glory_attended: number
          glory_rate: number
          glory_score: number
          glory_total: number
          glory_total_weeks: number
          guild: string
          gvg_attended: number
          gvg_avg_prep: number
          gvg_avg_pvp: number
          gvg_rate: number
          gvg_total: number
          power: number
          pseudo: string
          scouting_tier: string
          server_number: string
          shadow_attended: number
          shadow_rate: number
          shadow_total: number
          svs_attended: number
          svs_avg_prep: number
          svs_avg_pvp: number
          svs_rate: number
          svs_total: number
        }[]
      }
      gm_delete_e2ee_conversation: {
        Args: { p_conversation_id: string }
        Returns: boolean
      }
      gm_delete_guild: {
        Args: { p_guild_id: string }
        Returns: {
          error: string
          ok: boolean
        }[]
      }
      gm_delete_player_absence: {
        Args: { p_id: string; p_uid: string }
        Returns: Json
      }
      gm_delete_war_session: {
        Args: { p_event_name: string; p_guild: string; p_session_id: string }
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
      gm_event_session_id: {
        Args: { p_date: string; p_event_name: string }
        Returns: string
      }
      gm_find_player_by_uid: { Args: { p_uid: string }; Returns: Json }
      gm_get_e2ee_prekey_bundle: {
        Args: { p_target_account_id: string }
        Returns: {
          account_id: string
          identity_key: string
          identity_signing_key: string
          one_time_key_id: number
          one_time_public_key: string
          registration_id: number
          signed_prekey: string
          signed_prekey_sig: string
        }[]
      }
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
      gm_get_player_metrics_history: {
        Args: { p_limit?: number; p_uid: string }
        Returns: Json
      }
      gm_get_push_prefs: { Args: { p_uid?: string }; Returns: Json }
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
      gm_guild_benchmark: {
        Args: never
        Returns: {
          active_events: number
          avg_power: number
          guild: string
          inactive_members: number
          max_power: number
          members: number
          participation_rate: number
          push_subs: number
          server_number: string
          subscription_type: string
          total_power: number
        }[]
      }
      gm_gvg_guild_matchup: {
        Args: never
        Returns: {
          avg_power: number
          avg_prep_score: number
          avg_pvp_score: number
          danger_score: number
          danger_tier: string
          guild: string
          gvg_count: number
          member_count: number
          server_number: string
          total_power: number
          total_prep_score: number
          total_pvp_score: number
        }[]
      }
      gm_gvg_player_matchup: {
        Args: never
        Returns: {
          avg_prep_score: number
          avg_pvp_score: number
          danger_score: number
          danger_tier: string
          guild: string
          gvg_count: number
          max_prep_score: number
          max_pvp_score: number
          power: number
          pseudo: string
          server_number: string
        }[]
      }
      gm_invoke_event_reminders: { Args: never; Returns: undefined }
      gm_is_admin_caller: { Args: never; Returns: boolean }
      gm_is_leader_caller: { Args: never; Returns: boolean }
      gm_leaderboard: {
        Args: { p_guild?: string; p_period?: string; p_week?: string }
        Returns: Json
      }
      gm_leave_e2ee_conversation: {
        Args: { p_conversation_id: string }
        Returns: boolean
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
      gm_list_war_sessions: {
        Args: { p_event_name: string; p_guild: string }
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
      gm_populate_event_participants: {
        Args: {
          p_event_name: string
          p_guild: string
          p_session_id: string
          p_week_start: string
        }
        Returns: number
      }
      gm_populate_event_participants_v2: {
        Args: { p_event_name: string; p_guild: string; p_week_start: string }
        Returns: number
      }
      gm_publish_e2ee_prekey_bundle: {
        Args: {
          p_identity_key: string
          p_identity_signing_key?: string
          p_one_time_prekeys?: Json
          p_registration_id: number
          p_signed_prekey: string
          p_signed_prekey_sig: string
        }
        Returns: boolean
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
      gm_reject_player_account: { Args: { p_id: string }; Returns: Json }
      gm_remove_e2ee_group_member: {
        Args: { p_conversation_id: string; p_target_account_id: string }
        Returns: boolean
      }
      gm_remove_member_from_active_events: {
        Args: { p_guild: string; p_pseudo: string }
        Returns: number
      }
      gm_rename_e2ee_conversation: {
        Args: { p_conversation_id: string; p_new_title: string }
        Returns: boolean
      }
      gm_reset_account_password: {
        Args: { p_id: string; p_password: string }
        Returns: {
          error: string
          ok: boolean
        }[]
      }
      gm_reset_demo_tenant_data: { Args: never; Returns: Json }
      gm_revoke_diplomatic_treaty: {
        Args: { p_treaty_id: string }
        Returns: boolean
      }
      gm_save_chest_tiers: {
        Args: { p_event_name: string; p_guild: string; p_tiers: Json }
        Returns: Json
      }
      gm_session_id_base: { Args: { p_session_id: string }; Returns: string }
      gm_set_join_code: {
        Args: { p_code: string; p_guild: string }
        Returns: Json
      }
      gm_set_push_prefs: {
        Args: { p_event_types: string[]; p_uid: string }
        Returns: Json
      }
      gm_sign_diplomatic_treaty: {
        Args: { p_treaty_id: string }
        Returns: boolean
      }
      gm_stats_data: { Args: { p_guild?: string }; Returns: Json }
      gm_svs_server_matchup: {
        Args: never
        Returns: {
          avg_prep_score: number
          avg_pvp_score: number
          danger_score: number
          danger_tier: string
          guild: string
          max_prep_score: number
          max_pvp_score: number
          power: number
          pseudo: string
          server_number: string
          svs_count: number
        }[]
      }
      gm_sync_shadowfront_participants: {
        Args: { p_guild: string; p_session_id: string }
        Returns: number
      }
      gm_toggle_block_leader: {
        Args: { p_block: boolean; p_target_account_id: string }
        Returns: boolean
      }
      gm_toggle_e2ee_reaction: {
        Args: { p_emoji: string; p_message_id: number }
        Returns: Json
      }
      gm_transfer_guild_member: {
        Args: { p_pseudo?: string; p_target_guild: string; p_uid: string }
        Returns: Json
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
      gm_update_player_timezone: {
        Args: { p_offset: number; p_uid: string }
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
        Args: { p_event_name: string; p_guild: string; p_rows: Json; p_session_id: string }
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
      is_server_admin: { Args: never; Returns: boolean }
      is_subscription_active: { Args: { p_guild: string }; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
      list_event_sessions: {
        Args: { p_guild?: string }
        Returns: {
          event_name: string
          participants: number
          participated_count: number
          session_id: string
          total_score: number
          week_start: string
        }[]
      }
      list_event_weeks: {
        Args: { p_guild?: string }
        Returns: {
          week_start: string
        }[]
      }
      request_guild_transfer: {
        Args: { p_target_guild: string; p_uid: string }
        Returns: Json
      }
      resolve_guild_transfer: {
        Args: { p_action: string; p_transfer_id: string }
        Returns: Json
      }
      save_push_subscription: {
        Args: {
          p_auth: string
          p_endpoint: string
          p_p256dh: string
          p_pseudo?: string
          p_ua?: string
        }
        Returns: Json
      }
      transfer_guild_member: {
        Args: { p_pseudo?: string; p_target_guild: string; p_uid: string }
        Returns: Json
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
