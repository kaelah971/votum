-- V2B.2.4 cross-ledger transaction-hash guard.
--
-- The funding bind RPC also performs this check. The trigger is the database
-- backstop for direct service-role writes and for future financial writers.

CREATE OR REPLACE FUNCTION public.prevent_reward_funding_hash_reuse()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _hash text;
    _lock_key bigint;
BEGIN
    _hash := COALESCE(NEW.submitted_transaction_hash, NEW.confirmed_transaction_hash);
    IF _hash IS NULL THEN
        RETURN NEW;
    END IF;

    _lock_key := ('x' || substr(_hash, 1, 15))::bit(64)::bigint;
    IF _lock_key = 0 THEN _lock_key := 1; END IF;
    PERFORM pg_advisory_xact_lock(_lock_key);

    IF EXISTS (
        SELECT 1 FROM public.nim_support_intents s
        WHERE s.submitted_transaction_hash = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.nim_contributions c
        WHERE c.transaction_hash = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.reward_payout_attempts p
        WHERE p.transaction_hash = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.reward_refunds r
        WHERE r.transaction_hash = _hash
    ) THEN
        RAISE EXCEPTION 'transaction hash already belongs to another financial record'
            USING ERRCODE = 'unique_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reward_funding_hash_reuse_guard
  ON public.reward_funding_transactions;

CREATE TRIGGER reward_funding_hash_reuse_guard
  BEFORE INSERT OR UPDATE OF submitted_transaction_hash, confirmed_transaction_hash
  ON public.reward_funding_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_reward_funding_hash_reuse();

GRANT EXECUTE ON FUNCTION public.prevent_reward_funding_hash_reuse TO service_role;
REVOKE EXECUTE ON FUNCTION public.prevent_reward_funding_hash_reuse FROM PUBLIC, anon, authenticated;
