-- Replace advisory lock derivation with a bullet-proof implementation
-- that doesn't depend on hex-to-bit casting or hashtext() edge cases.
--
-- The lock key is derived from the idempotency key UUID by parsing its
-- hex characters (15 chars = 60 bits, safe for bigint). This avoids any
-- dependency on cast behaviours that may vary across PostgreSQL versions.

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
    _hex        text;
    _i          int;
    _ch         text;
    _digit      int;
    _existing   record;
    _poll_id    uuid;
    _opt_label  text;
    _idx        int;
BEGIN
    -- Derive a deterministic lock key from the idempotency key UUID.
    -- Parse first 15 hex chars of the UUID (dashes stripped) into a bigint.
    -- 15 hex chars = 60 bits, well within the signed bigint range.
    -- This produces a stable, unique-by-key value for pg_advisory_xact_lock
    -- without any hex-to-bit cast ambiguity.
    _hex := replace(_idempotency_key::text, '-', '');
    _lock_key := 0;
    FOR _i IN 1..15 LOOP
        _ch := lower(substr(_hex, _i, 1));
        _digit := CASE _ch
            WHEN '0' THEN 0 WHEN '1' THEN 1 WHEN '2' THEN 2
            WHEN '3' THEN 3 WHEN '4' THEN 4 WHEN '5' THEN 5
            WHEN '6' THEN 6 WHEN '7' THEN 7 WHEN '8' THEN 8
            WHEN '9' THEN 9 WHEN 'a' THEN 10 WHEN 'b' THEN 11
            WHEN 'c' THEN 12 WHEN 'd' THEN 13 WHEN 'e' THEN 14
            WHEN 'f' THEN 15 ELSE 0
        END;
        _lock_key := _lock_key * 16 + _digit;
    END LOOP;
    -- Ensure non-zero (pg_advisory_xact_lock(0) is a valid but shared lock;
    -- using non-zero guarantees per-key isolation).
    IF _lock_key = 0 THEN
        _lock_key := 1;
    END IF;

    PERFORM pg_advisory_xact_lock(_lock_key);

    -- Check for existing publication request (includes fingerprint).
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
