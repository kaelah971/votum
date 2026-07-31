-- Public users only need read access to public Votum polls.
revoke all privileges
on table public.polls, public.poll_options
from anon, authenticated;

grant select
on table public.polls, public.poll_options
to anon, authenticated;