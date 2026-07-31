-- Wallet Proof & Sessions
-- Private tables accessed only via Supabase secret key (server-side).

CREATE TABLE public.wallet_challenges (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address  text NOT NULL,
    message         text NOT NULL,
    origin          text NOT NULL,
    expires_at      timestamptz NOT NULL,
    used_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT wallet_challenges_wallet_address_not_empty CHECK (length(trim(wallet_address)) > 0),
    CONSTRAINT wallet_challenges_message_not_empty CHECK (length(trim(message)) > 0),
    CONSTRAINT wallet_challenges_message_max_length CHECK (length(message) <= 600),
    CONSTRAINT wallet_challenges_origin_max_length CHECK (length(origin) <= 256),
    CONSTRAINT wallet_challenges_expires_after_created CHECK (expires_at > created_at)
);

CREATE INDEX idx_wallet_challenges_wallet ON public.wallet_challenges (wallet_address);
CREATE INDEX idx_wallet_challenges_expires ON public.wallet_challenges (expires_at);
-- For fetching unused challenges efficiently
CREATE INDEX idx_wallet_challenges_unused ON public.wallet_challenges (wallet_address, expires_at) WHERE used_at IS NULL;

CREATE TABLE public.wallet_sessions (
    token_hash   text PRIMARY KEY,
    wallet_address text NOT NULL,
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,

    CONSTRAINT wallet_sessions_token_hash_not_empty CHECK (length(trim(token_hash)) > 0),
    CONSTRAINT wallet_sessions_wallet_address_not_empty CHECK (length(trim(wallet_address)) > 0),
    CONSTRAINT wallet_sessions_expires_after_created CHECK (expires_at > created_at)
);

CREATE INDEX idx_wallet_sessions_wallet ON public.wallet_sessions (wallet_address);
CREATE INDEX idx_wallet_sessions_expires ON public.wallet_sessions (expires_at);

-- RLS: disabled for public roles
ALTER TABLE public.wallet_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_sessions ENABLE ROW LEVEL SECURITY;

-- Revoke all public access
REVOKE ALL ON public.wallet_challenges FROM anon, authenticated;
REVOKE ALL ON public.wallet_sessions FROM anon, authenticated;
