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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      poll_options: {
        Row: {
          created_at: string
          id: string
          label: string
          poll_id: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          id?: string
          label: string
          poll_id: string
          sort_order: number
        }
        Update: {
          created_at?: string
          id?: string
          label?: string
          poll_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "poll_options_poll_id_fkey"
            columns: ["poll_id"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
        ]
      }
      poll_publication_requests: {
        Row: {
          created_at: string
          creator_wallet: string
          id: string
          idempotency_key: string
          poll_id: string
          request_fingerprint: string
        }
        Insert: {
          created_at?: string
          creator_wallet: string
          id?: string
          idempotency_key: string
          poll_id: string
          request_fingerprint: string
        }
        Update: {
          created_at?: string
          creator_wallet?: string
          id?: string
          idempotency_key?: string
          poll_id?: string
          request_fingerprint?: string
        }
        Relationships: []
      }
      poll_votes: {
        Row: {
          created_at: string
          id: string
          option_id: string
          poll_id: string
          voter_wallet: string
        }
        Insert: {
          created_at?: string
          id?: string
          option_id: string
          poll_id: string
          voter_wallet: string
        }
        Update: {
          created_at?: string
          id?: string
          option_id?: string
          poll_id?: string
          voter_wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "poll_votes_option_id_fkey"
            columns: ["option_id"]
            isOneToOne: false
            referencedRelation: "poll_options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_votes_poll_id_fkey"
            columns: ["poll_id"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
        ]
      }
      participant_profiles: {
        Row: {
          wallet_address: string
          display_name: string | null
          handle: string | null
          verified_at: string
          created_at: string
          updated_at: string
        }
        Insert: {
          wallet_address: string
          display_name?: string | null
          handle?: string | null
          verified_at?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          wallet_address?: string
          display_name?: string | null
          handle?: string | null
          verified_at?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      polls: {
        Row: {
          category: "sports" | "entertainment" | "brands_products" | "communities" | "other"
          created_at: string
          creator_wallet: string
          description: string | null
          destination_purpose: string
          destination_wallet: string
          ends_at: string
          fairness_mode: string
          format: "decision" | "prediction" | "fan_vote" | "ranking" | "nomination" | "audience_choice"
          id: string
          is_public: boolean
          min_nim_luna: number
          mode: string
          published_at: string | null
          question: string
          starts_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          category?: "sports" | "entertainment" | "brands_products" | "communities" | "other"
          created_at?: string
          creator_wallet: string
          description?: string | null
          destination_purpose: string
          destination_wallet: string
          ends_at: string
          fairness_mode?: string
          format?: "decision" | "prediction" | "fan_vote" | "ranking" | "nomination" | "audience_choice"
          id?: string
          is_public?: boolean
          min_nim_luna: number
          mode: string
          published_at?: string | null
          question: string
          starts_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          category?: "sports" | "entertainment" | "brands_products" | "communities" | "other"
          created_at?: string
          creator_wallet?: string
          description?: string | null
          destination_purpose?: string
          destination_wallet?: string
          ends_at?: string
          fairness_mode?: string
          format?: "decision" | "prediction" | "fan_vote" | "ranking" | "nomination" | "audience_choice"
          id?: string
          is_public?: boolean
          min_nim_luna?: number
          mode?: string
          published_at?: string | null
          question?: string
          starts_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      wallet_challenges: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          message: string
          origin: string
          used_at: string | null
          wallet_address: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          message: string
          origin: string
          used_at?: string | null
          wallet_address: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          message?: string
          origin?: string
          used_at?: string | null
          wallet_address?: string
        }
        Relationships: []
      }
      wallet_sessions: {
        Row: {
          created_at: string
          expires_at: string
          last_seen_at: string | null
          revoked_at: string | null
          token_hash: string
          wallet_address: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          last_seen_at?: string | null
          revoked_at?: string | null
          token_hash: string
          wallet_address: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          last_seen_at?: string | null
          revoked_at?: string | null
          token_hash?: string
          wallet_address?: string
        }
        Relationships: []
      }
      reward_campaigns: {
        Row: {
          asset: string
          closed_at: string | null
          created_at: string
          creator_wallet: string
          fee_reserve_luna: number
          fee_spent_luna: number
          first_reservation_at: string | null
          funded_amount_luna: number
          funded_at: string | null
          id: string
          max_rewarded_participants: number
          paid_amount_luna: number
          poll_id: string
          refundable_amount_luna: number
          refundable_excess_luna: number
          refunded_at: string | null
          reward_per_participant_luna: number
          reward_principal_luna: number
          rewarded_participant_count: number
          status: string
          total_budget_luna: number
          updated_at: string
          vault_key_ref: string | null
          vault_wallet: string | null
        }
        Insert: {
          asset?: string
          closed_at?: string | null
          created_at?: string
          creator_wallet: string
          fee_reserve_luna?: number
          fee_spent_luna?: number
          first_reservation_at?: string | null
          funded_amount_luna?: number
          funded_at?: string | null
          id?: string
          max_rewarded_participants: number
          paid_amount_luna?: number
          poll_id: string
          refundable_amount_luna?: number
          refundable_excess_luna?: number
          refunded_at?: string | null
          reward_per_participant_luna: number
          reward_principal_luna: number
          rewarded_participant_count?: number
          status?: string
          total_budget_luna: number
          updated_at?: string
          vault_key_ref?: string | null
          vault_wallet?: string | null
        }
        Update: {
          asset?: string
          closed_at?: string | null
          created_at?: string
          creator_wallet?: string
          fee_reserve_luna?: number
          fee_spent_luna?: number
          first_reservation_at?: string | null
          funded_amount_luna?: number
          funded_at?: string | null
          id?: string
          max_rewarded_participants?: number
          paid_amount_luna?: number
          poll_id?: string
          refundable_amount_luna?: number
          refundable_excess_luna?: number
          refunded_at?: string | null
          reward_per_participant_luna?: number
          reward_principal_luna?: number
          rewarded_participant_count?: number
          status?: string
          total_budget_luna?: number
          updated_at?: string
          vault_key_ref?: string | null
          vault_wallet?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reward_campaigns_poll_id_fkey"
            columns: ["poll_id"]
            isOneToOne: true
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
        ]
      }
      reward_funding_transactions: {
        Row: {
          amount_luna: number
          block_number: number | null
          campaign_id: string
          confirmed_at: string | null
          confirmed_transaction_hash: string | null
          confirmation_deadline: string | null
          created_at: string
          creator_wallet: string
          id: string
          reference: string
          status: string
          submitted_transaction_hash: string | null
          transaction_timestamp: string | null
          updated_at: string
        }
        Insert: {
          amount_luna: number
          block_number?: number | null
          campaign_id: string
          confirmed_at?: string | null
          confirmed_transaction_hash?: string | null
          confirmation_deadline?: string | null
          created_at?: string
          creator_wallet: string
          id?: string
          reference: string
          status?: string
          submitted_transaction_hash?: string | null
          transaction_timestamp?: string | null
          updated_at?: string
        }
        Update: {
          amount_luna?: number
          block_number?: number | null
          campaign_id?: string
          confirmed_at?: string | null
          confirmed_transaction_hash?: string | null
          confirmation_deadline?: string | null
          created_at?: string
          creator_wallet?: string
          id?: string
          reference?: string
          status?: string
          submitted_transaction_hash?: string | null
          transaction_timestamp?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reward_funding_transactions_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "reward_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      reward_payout_attempts: {
        Row: {
          attempt_number: number
          broadcast_at: string | null
          confirmed_at: string | null
          created_at: string
          error_code: string | null
          id: string
          receipt_id: string
          status: string
          transaction_hash: string | null
          updated_at: string
        }
        Insert: {
          attempt_number: number
          broadcast_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          error_code?: string | null
          id?: string
          receipt_id: string
          status?: string
          transaction_hash?: string | null
          updated_at?: string
        }
        Update: {
          attempt_number?: number
          broadcast_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          error_code?: string | null
          id?: string
          receipt_id?: string
          status?: string
          transaction_hash?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reward_payout_attempts_receipt_id_fkey"
            columns: ["receipt_id"]
            isOneToOne: false
            referencedRelation: "reward_receipts"
            referencedColumns: ["id"]
          },
        ]
      }
      reward_receipts: {
        Row: {
          amount_luna: number
          campaign_id: string
          created_at: string
          id: string
          paid_at: string | null
          participant_wallet: string
          poll_id: string
          status: string
          updated_at: string
        }
        Insert: {
          amount_luna: number
          campaign_id: string
          created_at?: string
          id?: string
          paid_at?: string | null
          participant_wallet: string
          poll_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount_luna?: number
          campaign_id?: string
          created_at?: string
          id?: string
          paid_at?: string | null
          participant_wallet?: string
          poll_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reward_receipts_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "reward_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reward_receipts_poll_id_fkey"
            columns: ["poll_id"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
        ]
      }
      reward_refunds: {
        Row: {
          amount_luna: number
          block_number: number | null
          campaign_id: string
          confirmed_at: string | null
          created_at: string
          creator_wallet: string
          id: string
          status: string
          transaction_hash: string | null
          transaction_timestamp: string | null
          updated_at: string
        }
        Insert: {
          amount_luna: number
          block_number?: number | null
          campaign_id: string
          confirmed_at?: string | null
          created_at?: string
          creator_wallet: string
          id?: string
          status?: string
          transaction_hash?: string | null
          transaction_timestamp?: string | null
          updated_at?: string
        }
        Update: {
          amount_luna?: number
          block_number?: number | null
          campaign_id?: string
          confirmed_at?: string | null
          created_at?: string
          creator_wallet?: string
          id?: string
          status?: string
          transaction_hash?: string | null
          transaction_timestamp?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reward_refunds_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "reward_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cast_poll_vote_atomic: {
        Args: Record<string, unknown>
        Returns: Json
      }
      get_public_poll_results: {
        Args: Record<string, unknown>
        Returns: Json
      }
      /** Atomic poll publication — returns { id, status, result_kind } */
      publish_poll_atomic: {
        Args: Record<string, unknown>
        Returns: Json
      }
      /** Public participant profile + derived stats + recent activity */
      get_participant_public_profile: {
        Args: { _wallet: string }
        Returns: Json
      }
      /** Public participant profile resolved by canonical handle */
      get_participant_public_profile_by_handle: {
        Args: { _handle: string }
        Returns: Json
      }
      /** Public reward-campaign surface (D7 allowlist) */
      get_public_reward_campaign: {
        Args: { _poll_id: string }
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
