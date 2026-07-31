-- Grant DELETE to service_role on poll-related tables.
-- Needed for administrative cleanup (test scripts, data management).
-- All tables already have RLS enabled; service_role bypasses RLS.

GRANT DELETE ON public.polls TO service_role;
GRANT DELETE ON public.poll_options TO service_role;
GRANT DELETE ON public.poll_publication_requests TO service_role;
