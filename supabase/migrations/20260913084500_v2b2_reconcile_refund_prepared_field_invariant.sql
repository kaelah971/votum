-- Reconcile older local databases with the canonical atomic prepared-refund shape.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.reward_refunds
    WHERE (
      prepared_transaction_hash IS NULL
      AND (
        prepared_transaction_hex IS NOT NULL
        OR sender_address_hex IS NOT NULL
        OR recipient_address_hex IS NOT NULL
        OR fee_luna IS NOT NULL
        OR network_id IS NOT NULL
        OR validity_start_height IS NOT NULL
        OR prepared_at IS NOT NULL
      )
    )
    OR (
      prepared_transaction_hash IS NOT NULL
      AND (
        prepared_transaction_hex IS NULL
        OR sender_address_hex IS NULL
        OR recipient_address_hex IS NULL
        OR fee_luna IS NULL
        OR network_id IS NULL
        OR validity_start_height IS NULL
        OR prepared_at IS NULL
      )
    )
  ) THEN
    RAISE EXCEPTION 'cannot reconcile reward refund prepared-field invariant: partial prepared rows exist'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

ALTER TABLE public.reward_refunds
  DROP CONSTRAINT IF EXISTS reward_refund_prepared_fields_complete;

ALTER TABLE public.reward_refunds
  ADD CONSTRAINT reward_refund_prepared_fields_complete
    CHECK (
      (
        prepared_transaction_hash IS NULL
        AND prepared_transaction_hex IS NULL
        AND sender_address_hex IS NULL
        AND recipient_address_hex IS NULL
        AND fee_luna IS NULL
        AND network_id IS NULL
        AND validity_start_height IS NULL
        AND prepared_at IS NULL
      )
      OR (
        prepared_transaction_hash IS NOT NULL
        AND prepared_transaction_hex IS NOT NULL
        AND sender_address_hex IS NOT NULL
        AND recipient_address_hex IS NOT NULL
        AND fee_luna IS NOT NULL
        AND network_id IS NOT NULL
        AND validity_start_height IS NOT NULL
        AND prepared_at IS NOT NULL
      )
    );
