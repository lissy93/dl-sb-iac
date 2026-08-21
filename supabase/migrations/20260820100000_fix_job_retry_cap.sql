-- Cap retries for permanently failing domains
--
-- `attempts` was a lifetime counter that was never reset, so healthy domains had
-- accumulated ~150 attempts each. It now counts consecutive failures: the worker
-- resets it on success, and stale jobs are only re-queued while under the cap.

alter table public.domain_update_jobs
  add column if not exists last_error text;

-- Existing values are lifetime totals, so clear them before the new meaning applies
update public.domain_update_jobs set attempts = 0 where attempts <> 0;

-- Re-queue completed jobs always, failed ones only while under the retry cap
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
  on conflict (domain, user_id) do update set
    status = 'queued',
    inserted_at = now()
  where domain_update_jobs.status = 'complete'
     or (domain_update_jobs.status = 'failed' and domain_update_jobs.attempts < 10);
$$;

-- Queueing every stale domain should not be reachable from the public API
revoke all on function public.enqueue_stale_domain_jobs() from public, anon, authenticated;
grant execute on function public.enqueue_stale_domain_jobs() to service_role;
