-- Hardened publish idempotency: content-aware fingerprint + advisory locks.
-- Prevents replay of different content under the same idempotency key
-- and protects against concurrent duplicate publication.
-- All DDL is idempotent (safe to re-run if migration partially applied).

-- ============================================================================
-- Add request fingerprint column for content-aware idempotency
-- ============================================================================
ALTER TABLE public.poll_publication_requests
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

-- Backfill: generate a placeholder hash for any existing rows.
-- Using a stable dummy value since production has no real requests yet.
UPDATE public.poll_publication_requests
  SET request_fingerprint = '0'
  WHERE request_fingerprint IS NULL;

-- Make NOT NULL for future inserts (safe to re-run).
ALTER TABLE public.poll_publication_requests
  ALTER COLUMN request_fingerprint SET NOT NULL;

-- ============================================================================
-- Replace the atomic publish function with hardened version.
-- Adds: advisory lock, fingerprint check, content-aware idempotency,
-- and conflict detection when idempotency key is reused with different content.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.publish_poll_atomic(
    _creator_wallet       text,
    _question             text,
    _description          text,
    _mode                 text,
    _destination_wallet   text,
    _destination_purpose  text,
    _min_nim_luna         bigint,
    _fairness_mode        text,
    _ends_at              timestamptz,
    _options              text[],
    _idempotency_key      uuid,
    _request_fingerprint  text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    _now        timestamptz := now();
    _lock_key   bigint;
    _existing   record;
    _poll_id    uuid;
    _opt_label  text;
    _idx        int;
BEGIN
    -- Derive a deterministic lock key from creator wallet and idempotency key.
    -- Hash the combined string to produce a stable bigint for pg_advisory_xact_lock.
    -- This ensures concurrent requests from the same creator+key serialise cleanly.
    _lock_key := ('x' || substr(md5(_creator_wallet || ':' || _idempotency_key::text), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(_lock_key);

    -- Check for existing publication request (includes fingerprint now).
    SELECT poll_id, request_fingerprint INTO _existing
    FROM public.poll_publication_requests
    WHERE creator_wallet = _creator_wallet
      AND idempotency_key = _idempotency_key;

    IF FOUND THEN
        IF _existing.request_fingerprint = _request_fingerprint THEN
            -- Same creator, same key, same content → genuine replay
            RETURN jsonb_build_object(
                'id', _existing.poll_id,
                'status', (SELECT status FROM public.polls WHERE id = _existing.poll_id),
                'replay', true
            );
        ELSE
            -- Same creator, same key, different content → conflict
            RAISE EXCEPTION 'idempotency_conflict'
                USING ERRCODE = '23505';  -- unique_violation maps cleanly to HTTP 409
        END IF;
    END IF;

    -- Validate options
    IF array_length(_options, 1) < 2 THEN
        RAISE EXCEPTION 'At least 2 options are required' USING ERRCODE = 'check_violation';
    END IF;

    IF array_length(_options, 1) > 6 THEN
        RAISE EXCEPTION 'Maximum 6 options allowed' USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(DISTINCT lower(trim(opt))) FROM unnest(_options) opt)
       <> array_length(_options, 1) THEN
        RAISE EXCEPTION 'Duplicate option labels are not allowed' USING ERRCODE = 'check_violation';
    END IF;

    -- Insert poll
    INSERT INTO public.polls (
        creator_wallet, question, description, mode,
        destination_wallet, destination_purpose,
        min_nim_luna, fairness_mode,
        status, starts_at, ends_at,
        is_public, published_at,
        created_at, updated_at
    ) VALUES (
        _creator_wallet, trim(_question),
        CASE WHEN _description IS NOT NULL AND length(trim(_description)) > 0
             THEN trim(_description) ELSE NULL END,
        _mode,
        _destination_wallet, trim(_destination_purpose),
        _min_nim_luna, _fairness_mode,
        'live', _now, _ends_at,
        true, _now,
        _now, _now
    )
    RETURNING id INTO _poll_id;

    -- Insert options
    _idx := 0;
    FOREACH _opt_label IN ARRAY _options LOOP
        INSERT INTO public.poll_options (poll_id, label, sort_order)
        VALUES (_poll_id, trim(_opt_label), _idx);
        _idx := _idx + 1;
    END LOOP;

    -- Record idempotency with fingerprint
    INSERT INTO public.poll_publication_requests
        (creator_wallet, idempotency_key, poll_id, request_fingerprint)
    VALUES (_creator_wallet, _idempotency_key, _poll_id, _request_fingerprint);

    RETURN jsonb_build_object(
        'id', _poll_id,
        'status', 'live',
        'replay', false
    );
END;
$$;

-- NOTE: No explicit GRANT needed — CREATE OR REPLACE FUNCTION preserves
-- existing privileges. service_role already has EXECUTE from the initial
-- publish_poll_atomic migration (20260730212451).
