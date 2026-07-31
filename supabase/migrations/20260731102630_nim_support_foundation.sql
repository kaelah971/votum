-- NIM support foundation: intents, contributions, atomic confirmation, and public aggregates.
-- No escrow, no payout — supporter → destination directly.

-- ============================================================================
-- SUPPORT INTENTS
-- ============================================================================

CREATE TABLE public.nim_support_intents (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reference                text UNIQUE NOT NULL,
    poll_id                  uuid NOT NULL REFERENCES public.polls(id),
    option_id                uuid NOT NULL REFERENCES public.poll_options(id),
    supporter_wallet         text NOT NULL,
    recipient_wallet         text NOT NULL,
    amount_luna              bigint NOT NULL,
    memo                     text NOT NULL,
    status                   text NOT NULL DEFAULT 'pending',
    expires_at               timestamptz NOT NULL,
    confirmed_contribution_id uuid,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT nim_support_intents_amount_positive CHECK (amount_luna > 0),
    CONSTRAINT nim_support_intents_status CHECK (status IN ('pending', 'confirmed', 'expired')),
    CONSTRAINT nim_support_intents_memo_length CHECK (octet_length(memo) <= 64)
);

CREATE INDEX idx_nim_intents_poll ON public.nim_support_intents (poll_id);
CREATE INDEX idx_nim_intents_supporter ON public.nim_support_intents (supporter_wallet);
CREATE INDEX idx_nim_intents_expires ON public.nim_support_intents (expires_at) WHERE status = 'pending';

-- ============================================================================
-- CONFIRMED CONTRIBUTIONS (immutable)
-- ============================================================================

CREATE TABLE public.nim_contributions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id             uuid UNIQUE NOT NULL REFERENCES public.nim_support_intents(id),
    poll_id               uuid NOT NULL REFERENCES public.polls(id),
    option_id             uuid NOT NULL REFERENCES public.poll_options(id),
    supporter_wallet      text NOT NULL,
    recipient_wallet      text NOT NULL,
    amount_luna           bigint NOT NULL,
    transaction_hash      text UNIQUE NOT NULL,
    block_number          bigint,
    transaction_timestamp timestamptz,
    confirmed_at          timestamptz NOT NULL DEFAULT now(),
    created_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT nim_contributions_amount_positive CHECK (amount_luna > 0)
);

CREATE INDEX idx_nim_contributions_poll ON public.nim_contributions (poll_id);
CREATE INDEX idx_nim_contributions_option ON public.nim_contributions (option_id);

-- ============================================================================
-- RLS — no public access
-- ============================================================================

ALTER TABLE public.nim_support_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nim_contributions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.nim_support_intents FROM anon, authenticated;
REVOKE ALL ON public.nim_contributions FROM anon, authenticated;

-- ============================================================================
-- ATOMIC CONFIRMATION FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_nim_contribution_atomic(
    _intent_id         uuid,
    _transaction_hash  text,
    _block_number      bigint,
    _transaction_ts    timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    _intent    record;
    _existing  record;
    _dup_hash  record;
    _contrib_id uuid;
BEGIN
    -- Load intent
    SELECT * INTO _intent
    FROM public.nim_support_intents
    WHERE id = _intent_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'intent_not_found');
    END IF;

    IF _intent.status = 'expired' OR _intent.expires_at <= now() THEN
        RETURN jsonb_build_object('result_kind', 'intent_expired');
    END IF;

    -- Already confirmed with this hash → replay
    IF _intent.status = 'confirmed' THEN
        SELECT * INTO _existing FROM public.nim_contributions WHERE intent_id = _intent_id;
        IF FOUND AND _existing.transaction_hash = _transaction_hash THEN
            RETURN jsonb_build_object(
                'result_kind', 'replay',
                'contribution_id', _existing.id
            );
        ELSE
            RETURN jsonb_build_object('result_kind', 'intent_already_used');
        END IF;
    END IF;

    -- Reject duplicate transaction hash globally
    SELECT id INTO _dup_hash FROM public.nim_contributions WHERE transaction_hash = _transaction_hash;
    IF FOUND THEN
        RETURN jsonb_build_object('result_kind', 'transaction_already_used');
    END IF;

    -- Insert contribution
    INSERT INTO public.nim_contributions (
        intent_id, poll_id, option_id,
        supporter_wallet, recipient_wallet,
        amount_luna, transaction_hash,
        block_number, transaction_timestamp
    ) VALUES (
        _intent_id, _intent.poll_id, _intent.option_id,
        _intent.supporter_wallet, _intent.recipient_wallet,
        _intent.amount_luna, _transaction_hash,
        _block_number, _transaction_ts
    )
    RETURNING id INTO _contrib_id;

    -- Mark intent confirmed
    UPDATE public.nim_support_intents
    SET status = 'confirmed', confirmed_contribution_id = _contrib_id, updated_at = now()
    WHERE id = _intent_id;

    RETURN jsonb_build_object(
        'result_kind', 'created',
        'contribution_id', _contrib_id
    );
END;
$$;

-- ============================================================================
-- PUBLIC AGGREGATE SUPPORT RESULTS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_public_support_results(_poll_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _total  bigint;
    _opts   jsonb;
BEGIN
    SELECT coalesce(sum(amount_luna), 0) INTO _total
    FROM public.nim_contributions
    WHERE poll_id = _poll_id;

    SELECT jsonb_agg(
        jsonb_build_object(
            'optionId', o.id,
            'label', o.label,
            'nimLuna', coalesce(c.luna, 0)::text,
            'contributionCount', coalesce(c.cnt, 0)
        )
        ORDER BY o.sort_order
    ) INTO _opts
    FROM public.poll_options o
    LEFT JOIN (
        SELECT option_id, sum(amount_luna) AS luna, count(*) AS cnt
        FROM public.nim_contributions
        WHERE poll_id = _poll_id
        GROUP BY option_id
    ) c ON c.option_id = o.id
    WHERE o.poll_id = _poll_id;

    RETURN jsonb_build_object(
        'pollId', _poll_id,
        'totalNimLuna', _total::text,
        'options', coalesce(_opts, '[]'::jsonb)
    );
END;
$$;

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT INSERT, SELECT ON public.nim_support_intents TO service_role;
GRANT UPDATE ON public.nim_support_intents TO service_role;

GRANT INSERT, SELECT ON public.nim_contributions TO service_role;

GRANT EXECUTE ON FUNCTION public.confirm_nim_contribution_atomic TO service_role;
REVOKE EXECUTE ON FUNCTION public.confirm_nim_contribution_atomic FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_public_support_results TO anon, authenticated, service_role;
