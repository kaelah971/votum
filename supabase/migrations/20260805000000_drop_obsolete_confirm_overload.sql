-- Drop the obsolete 4-argument confirm_nim_contribution_atomic overload.
-- The canonical 5-argument version (with _tx_sender) was introduced in
-- 20260731125042_separate_initiator_supporter.sql and is the one called
-- by the production confirm route.
--
-- The 4-arg overload was created by 20260731104331_harden_nim_support_lifecycle.sql
-- but never fully replaced when the 5-arg version was added via CREATE OR REPLACE,
-- because PostgreSQL treats them as separate overloads.
--
-- Both overloads coexisting causes PostgREST RPC resolution ambiguity;
-- the production route sends 5 named arguments and must resolve to the
-- 5-arg version deterministically.

DROP FUNCTION IF EXISTS public.confirm_nim_contribution_atomic(
    _intent_id         uuid,
    _transaction_hash  text,
    _block_number      bigint,
    _transaction_ts    timestamptz
);
