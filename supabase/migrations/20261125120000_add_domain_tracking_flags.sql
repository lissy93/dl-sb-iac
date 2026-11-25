-- Per-domain archiving, plus switches to pause uptime monitoring and auto updates

alter table public.domains
  add column if not exists archived_at timestamp with time zone,
  add column if not exists monitor_enabled boolean not null default true,
  add column if not exists updates_enabled boolean not null default true;

-- Same as before, but skipping domains with updates turned off
create or replace function public.enqueue_stale_domain_jobs()
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.domain_update_jobs (domain, user_id)
  select domain_name, user_id
  from public.domains
  where updated_at < now() - interval '24 hours'
    and updates_enabled
  on conflict (domain, user_id) do update set
    status = 'queued',
    inserted_at = now()
  where domain_update_jobs.status = 'complete'
     or (domain_update_jobs.status = 'failed' and domain_update_jobs.attempts < 10);
$$;
