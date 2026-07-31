alter policy polls_public_read
on public.polls
to anon, authenticated;

alter policy poll_options_public_read
on public.poll_options
to anon, authenticated;