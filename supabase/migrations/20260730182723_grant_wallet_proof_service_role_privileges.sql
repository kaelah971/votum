-- Grant service_role privileges for wallet-proof tables.
--
-- The wallet_challenges and wallet_sessions tables were created with RLS
-- enabled and all anon/authenticated access revoked.  This migration
-- explicitly grants the server-side service_role the privileges required
-- to create challenges, insert sessions, and perform lookups through
-- the Supabase admin client (secret key).
--
-- No public roles receive write access.  RLS remains enabled.

grant usage on schema public to service_role;

grant select, insert, update, delete
on table public.wallet_challenges
to service_role;

grant select, insert, update, delete
on table public.wallet_sessions
to service_role;
