-- V2C.2B additive settlement references for existing Poll financial children.
-- reward_campaigns and campaign_id remain the live Poll authority in this slice.

ALTER TABLE public.reward_funding_transactions
  ADD COLUMN settlement_id uuid;

ALTER TABLE public.reward_funding_transactions
  ADD CONSTRAINT reward_funding_transactions_settlement_id_fkey
  FOREIGN KEY (settlement_id) REFERENCES public.reward_settlements(id);

ALTER TABLE public.reward_receipts
  ADD COLUMN settlement_id uuid;

ALTER TABLE public.reward_receipts
  ADD CONSTRAINT reward_receipts_settlement_id_fkey
  FOREIGN KEY (settlement_id) REFERENCES public.reward_settlements(id);

ALTER TABLE public.reward_refunds
  ADD COLUMN settlement_id uuid;

ALTER TABLE public.reward_refunds
  ADD CONSTRAINT reward_refunds_settlement_id_fkey
  FOREIGN KEY (settlement_id) REFERENCES public.reward_settlements(id);

ALTER TABLE public.reward_campaign_vaults
  ADD COLUMN settlement_id uuid;

ALTER TABLE public.reward_campaign_vaults
  ADD CONSTRAINT reward_campaign_vaults_settlement_id_fkey
  FOREIGN KEY (settlement_id) REFERENCES public.reward_settlements(id);

-- The Poll binding is the validated source relationship. No wallet or financial
-- source column is normalized or rewritten by this backfill.
UPDATE public.reward_funding_transactions f
SET settlement_id = c.settlement_id
FROM public.reward_campaigns c
JOIN public.settlement_source_bindings b
  ON b.reward_campaign_id = c.id
 AND b.source_type = 'poll_reward_campaign'
 AND b.settlement_id = c.settlement_id
WHERE f.campaign_id = c.id;

UPDATE public.reward_receipts r
SET settlement_id = c.settlement_id
FROM public.reward_campaigns c
JOIN public.settlement_source_bindings b
  ON b.reward_campaign_id = c.id
 AND b.source_type = 'poll_reward_campaign'
 AND b.settlement_id = c.settlement_id
WHERE r.campaign_id = c.id;

UPDATE public.reward_refunds r
SET settlement_id = c.settlement_id
FROM public.reward_campaigns c
JOIN public.settlement_source_bindings b
  ON b.reward_campaign_id = c.id
 AND b.source_type = 'poll_reward_campaign'
 AND b.settlement_id = c.settlement_id
WHERE r.campaign_id = c.id;

-- Vault data is deliberately not selected in this statement. Only the new
-- relationship column receives the existing campaign UUID.
UPDATE public.reward_campaign_vaults
SET settlement_id = campaign_id;

DO $$
DECLARE
    _bad record;
BEGIN
    SELECT f.id, 'reward_funding_transactions' AS table_name
    INTO _bad
    FROM public.reward_funding_transactions f
    LEFT JOIN public.reward_campaigns c ON c.id = f.campaign_id
    LEFT JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id = c.id
     AND b.source_type = 'poll_reward_campaign'
    WHERE f.settlement_id IS NULL
       OR c.settlement_id IS NULL
       OR f.settlement_id IS DISTINCT FROM c.settlement_id
       OR f.settlement_id IS DISTINCT FROM b.settlement_id
       OR lower(trim(f.creator_wallet)) IS DISTINCT FROM lower(trim(c.creator_wallet))
       OR lower(trim(f.funder_wallet)) IS DISTINCT FROM lower(trim(c.funding_wallet))
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2b child backfill blocked: table=% row_id=%',
            _bad.table_name, _bad.id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT r.id, 'reward_receipts' AS table_name
    INTO _bad
    FROM public.reward_receipts r
    LEFT JOIN public.reward_campaigns c ON c.id = r.campaign_id
    LEFT JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id = c.id
     AND b.source_type = 'poll_reward_campaign'
    WHERE r.settlement_id IS NULL
       OR c.settlement_id IS NULL
       OR r.settlement_id IS DISTINCT FROM c.settlement_id
       OR r.settlement_id IS DISTINCT FROM b.settlement_id
       OR r.poll_id IS DISTINCT FROM c.poll_id
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2b child backfill blocked: table=% row_id=%',
            _bad.table_name, _bad.id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT r.id, 'reward_refunds' AS table_name
    INTO _bad
    FROM public.reward_refunds r
    LEFT JOIN public.reward_campaigns c ON c.id = r.campaign_id
    LEFT JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id = c.id
     AND b.source_type = 'poll_reward_campaign'
    LEFT JOIN public.reward_settlements s ON s.id = r.settlement_id
    WHERE r.settlement_id IS NULL
       OR c.settlement_id IS NULL
       OR r.settlement_id IS DISTINCT FROM c.settlement_id
       OR r.settlement_id IS DISTINCT FROM b.settlement_id
       OR lower(trim(r.creator_wallet)) IS DISTINCT FROM lower(trim(s.refund_recipient_wallet))
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2b child backfill blocked: table=% row_id=%',
            _bad.table_name, _bad.id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT v.campaign_id, 'reward_campaign_vaults' AS table_name
    INTO _bad
    FROM public.reward_campaign_vaults v
    LEFT JOIN public.reward_campaigns c ON c.id = v.campaign_id
    LEFT JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id = c.id
     AND b.source_type = 'poll_reward_campaign'
    LEFT JOIN public.reward_settlements s ON s.id = v.settlement_id
    WHERE v.settlement_id IS NULL
       OR c.settlement_id IS NULL
       OR v.settlement_id IS DISTINCT FROM c.settlement_id
       OR v.settlement_id IS DISTINCT FROM b.settlement_id
       OR lower(trim(s.owner_wallet)) IS DISTINCT FROM lower(trim(c.creator_wallet))
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2b child backfill blocked: table=% row_id=%',
            _bad.table_name, _bad.campaign_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.reward_campaign_vaults
        WHERE settlement_id IS NOT NULL
        GROUP BY settlement_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'v2c2b vault settlement uniqueness validation failed'
            USING ERRCODE = 'unique_violation';
    END IF;
END;
$$;

ALTER TABLE public.reward_funding_transactions
  ALTER COLUMN settlement_id SET NOT NULL;

ALTER TABLE public.reward_receipts
  ALTER COLUMN settlement_id SET NOT NULL;

ALTER TABLE public.reward_refunds
  ALTER COLUMN settlement_id SET NOT NULL;

CREATE INDEX idx_reward_funding_settlement
  ON public.reward_funding_transactions (settlement_id);

CREATE INDEX idx_reward_receipts_settlement
  ON public.reward_receipts (settlement_id);

CREATE INDEX idx_reward_refunds_settlement
  ON public.reward_refunds (settlement_id);

CREATE UNIQUE INDEX idx_reward_campaign_vaults_settlement
  ON public.reward_campaign_vaults (settlement_id)
  WHERE settlement_id IS NOT NULL;

-- Keep the two identifiers tied while both are present. A future standalone
-- Campaign vault may use a settlement without a Poll campaign after V2C.2E.
CREATE OR REPLACE FUNCTION public.validate_reward_settlement_child_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign_settlement uuid;
    _binding_settlement uuid;
BEGIN
    IF NEW.campaign_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c.settlement_id
    INTO _campaign_settlement
    FROM public.reward_campaigns c
    WHERE c.id = NEW.campaign_id;

    IF NOT FOUND OR _campaign_settlement IS NULL THEN
        -- A campaign without a staged root is outside this compatibility phase.
        -- Leave nullable vault rows alone; required financial children fail at
        -- their NOT NULL boundary rather than inventing a root.
        IF NEW.settlement_id IS NULL THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'settlement child campaign/root mismatch'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NEW.settlement_id IS NULL THEN
        NEW.settlement_id := _campaign_settlement;
    ELSIF _campaign_settlement IS DISTINCT FROM NEW.settlement_id THEN
        RAISE EXCEPTION 'settlement child campaign/root mismatch'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT b.settlement_id
    INTO _binding_settlement
    FROM public.settlement_source_bindings b
    WHERE b.reward_campaign_id = NEW.campaign_id
      AND b.source_type = 'poll_reward_campaign';

    IF NOT FOUND OR _binding_settlement IS DISTINCT FROM NEW.settlement_id THEN
        RAISE EXCEPTION 'settlement child Poll binding mismatch'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_reward_settlement_child_reference() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_reward_settlement_child_reference() TO service_role;

CREATE TRIGGER reward_funding_settlement_reference_guard
  BEFORE INSERT OR UPDATE OF campaign_id, settlement_id
  ON public.reward_funding_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_reward_settlement_child_reference();

CREATE TRIGGER reward_receipt_settlement_reference_guard
  BEFORE INSERT OR UPDATE OF campaign_id, settlement_id
  ON public.reward_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_reward_settlement_child_reference();

CREATE TRIGGER reward_refund_settlement_reference_guard
  BEFORE INSERT OR UPDATE OF campaign_id, settlement_id
  ON public.reward_refunds
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_reward_settlement_child_reference();

CREATE TRIGGER reward_vault_settlement_reference_guard
  BEFORE INSERT OR UPDATE OF campaign_id, settlement_id
  ON public.reward_campaign_vaults
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_reward_settlement_child_reference();
