-- Grant service_role the minimum required privileges on poll tables.
-- service_role is the role used by the Votum admin client (SUPABASE_SECRET_KEY).
-- anon and authenticated were already restricted to SELECT-only by migration 0001.

GRANT INSERT ON public.polls TO service_role;
GRANT SELECT, INSERT ON public.poll_options TO service_role;
GRANT SELECT, INSERT ON public.poll_publication_requests TO service_role;
GRANT SELECT, UPDATE ON public.polls TO service_role;
