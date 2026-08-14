-- V2B.1 — Verified participant profiles foundation.
-- Additive only: new table, additive indexes, backfill, public read RPCs.
-- No existing row or column is altered; no destructive operation.

-- ============================================================================
-- PARTICIPANT PROFILES
-- ============================================================================
-- Presentation/identity metadata anchored on the canonical-hex wallet address.
-- This table is NOT a source of voting or support truth — it never stores
-- counts, totals, or choices. Stats and activity are derived at read time
-- from the authoritative polls / poll_votes / nim_contributions records.

CREATE TABLE public.participant_profiles (
    wallet_address text PRIMARY KEY,
    display_name   text,
    handle         text,
    verified_at    timestamptz NOT NULL DEFAULT now(),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT participant_profiles_wallet_not_empty CHECK (length(trim(wallet_address)) > 0),
    CONSTRAINT participant_profiles_display_name_length CHECK (
        display_name IS NULL OR char_length(trim(display_name)) BETWEEN 1 AND 40
    ),
    CONSTRAINT participant_profiles_display_name_no_newline CHECK (
        display_name IS NULL OR position(E'\n' IN display_name) = 0
    ),
    CONSTRAINT participant_profiles_handle_format CHECK (
        handle IS NULL OR handle ~ '^[a-z0-9_]{3,24}$'
    )
);

-- Database-authoritative handle uniqueness: exactly one concurrent claim wins.
CREATE UNIQUE INDEX participant_profiles_handle_uniq
    ON public.participant_profiles (handle)
    WHERE handle IS NOT NULL;

-- ============================================================================
-- ADDITIVE INDEXES FOR DERIVED PROFILE STATS / ACTIVITY
-- ============================================================================
-- Wallet-led participation lookup (stats count + recent activity ordering).
CREATE INDEX idx_poll_votes_voter_wallet
    ON public.poll_votes (voter_wallet, created_at DESC);

-- Confirmed NIM support totals per wallet.
CREATE INDEX idx_nim_contributions_supporter
    ON public.nim_contributions (supporter_wallet);

-- ============================================================================
-- RLS — private table; service_role writes; anon/authenticated fully revoked.
-- Public reads flow exclusively through the SECURITY DEFINER functions below
-- (same pattern as get_public_poll_results / get_public_support_results).
-- ============================================================================

ALTER TABLE public.participant_profiles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.participant_profiles FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.participant_profiles TO service_role;

-- ============================================================================
-- BACKFILL — idempotent, non-destructive, ON CONFLICT DO NOTHING.
-- ============================================================================
-- Identity sources (authoritative, session-gated):
--   1. wallet_sessions  — the verification ledger. A row exists ONLY after a
--      successful challenge → explicit signature → atomic consume → session
--      creation. Logout marks revoked_at; nothing ever deletes session rows,
--      so every distinct wallet here is a proven verified wallet, and
--      MIN(created_at) is its true first-verification timestamp.
--   2. public polls     — publish requires a verified session.
--   3. public poll votes — casting requires a verified session.
--   4. confirmed NIM contributions — intent + confirmation require a verified
--      session; only confirmed rows (nim_contributions) are used.
-- Deliberately EXCLUDED: wallet_challenges — those wallet_address values are
-- arbitrary pre-signature submissions and carry NO verification semantics.
--
-- verified_at is preserved as the earliest real evidence timestamp
-- (first session creation, else first activity timestamp); it is never
-- silently rewritten to the backfill time.

INSERT INTO public.participant_profiles (wallet_address, verified_at)
SELECT w.wallet_address, MIN(w.ts) AS verified_at
FROM (
    -- Verification ledger: true first-verification evidence.
    SELECT wallet_address, MIN(created_at) AS ts
    FROM public.wallet_sessions
    GROUP BY wallet_address

    UNION ALL

    -- Defensive: wallets present in any session-gated public activity record
    -- (covers hypothetical legacy data without session rows).
    SELECT p.creator_wallet, MIN(p.created_at)
    FROM public.polls p
    WHERE p.is_public = true AND p.status IN ('live', 'closed')
    GROUP BY p.creator_wallet

    UNION ALL

    SELECT v.voter_wallet, MIN(v.created_at)
    FROM public.poll_votes v
    JOIN public.polls p ON p.id = v.poll_id
    WHERE p.is_public = true AND p.status IN ('live', 'closed')
    GROUP BY v.voter_wallet

    UNION ALL

    SELECT c.supporter_wallet, MIN(c.confirmed_at)
    FROM public.nim_contributions c
    GROUP BY c.supporter_wallet
) w
GROUP BY w.wallet_address
ON CONFLICT (wallet_address) DO NOTHING;

-- ============================================================================
-- PUBLIC READ RPCs — SECURITY DEFINER, locked search_path, anon-executable.
-- ============================================================================
-- Public poll boundary preserved everywhere: is_public = true AND
-- status IN ('live','closed'). Vote choice privacy: the participation branch
-- selects only polls.question; poll_votes.option_id is never selected and
-- poll_options is never joined — a chosen option cannot be exposed.

CREATE OR REPLACE FUNCTION public.get_participant_public_profile(_wallet text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _canonical text;
    _profile   record;
    _stats     jsonb;
    _activity  jsonb;
BEGIN
    _canonical := lower(btrim(_wallet));

    -- Reject anything that is not canonical hex (defensive; the API layer
    -- normalizes before calling, this guard prevents bypass via raw RPC).
    IF _canonical IS NULL OR _canonical !~ '^[0-9a-f]+$' THEN
        RETURN jsonb_build_object('result_kind', 'invalid_address');
    END IF;

    SELECT wallet_address, display_name, handle, verified_at, created_at
    INTO _profile
    FROM public.participant_profiles
    WHERE wallet_address = _canonical;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'not_found');
    END IF;

    SELECT jsonb_build_object(
        'pollsCreated',
            (SELECT count(*) FROM public.polls p
             WHERE p.creator_wallet = _canonical
               AND p.is_public = true AND p.status IN ('live', 'closed')),
        'participations',
            (SELECT count(*) FROM public.poll_votes v
             JOIN public.polls p ON p.id = v.poll_id
             WHERE v.voter_wallet = _canonical
               AND p.is_public = true AND p.status IN ('live', 'closed')),
        'nimSupportedLuna',
            (SELECT coalesce(sum(c.amount_luna), 0)::text
             FROM public.nim_contributions c
             WHERE c.supporter_wallet = _canonical),
        'nimEarnedLuna', '0'
    ) INTO _stats;

    SELECT coalesce(jsonb_agg(
        jsonb_build_object(
            'kind', t.kind,
            'pollId', t.poll_id,
            'question', t.question,
            'at', t.at
        )
    ), '[]'::jsonb) INTO _activity
    FROM (
        SELECT 'created'::text AS kind, p.id::text AS poll_id,
               p.question, p.created_at AS at
        FROM public.polls p
        WHERE p.creator_wallet = _canonical
          AND p.is_public = true AND p.status IN ('live', 'closed')

        UNION ALL

        SELECT 'participated'::text AS kind, p.id::text AS poll_id,
               p.question, v.created_at AS at
        FROM public.poll_votes v
        JOIN public.polls p ON p.id = v.poll_id
        WHERE v.voter_wallet = _canonical
          AND p.is_public = true AND p.status IN ('live', 'closed')

        ORDER BY at DESC, poll_id DESC
        LIMIT 12
    ) t;

    RETURN jsonb_build_object(
        'result_kind', 'found',
        'profile', jsonb_build_object(
            'walletAddress', _profile.wallet_address,
            'displayName', _profile.display_name,
            'handle', _profile.handle,
            'verifiedAt', _profile.verified_at,
            'joinedDate', _profile.created_at
        ),
        'stats', _stats,
        'activity', _activity
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_participant_public_profile_by_handle(_handle text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _canonical text;
    _wallet    text;
BEGIN
    _canonical := lower(btrim(_handle));

    IF _canonical IS NULL OR _canonical !~ '^[a-z0-9_]{3,24}$' THEN
        RETURN jsonb_build_object('result_kind', 'invalid_handle');
    END IF;

    SELECT wallet_address INTO _wallet
    FROM public.participant_profiles
    WHERE handle = _canonical;

    IF _wallet IS NULL THEN
        RETURN jsonb_build_object('result_kind', 'not_found');
    END IF;

    RETURN public.get_participant_public_profile(_wallet);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_participant_public_profile(text)
    TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_participant_public_profile_by_handle(text)
    TO anon, authenticated, service_role;
