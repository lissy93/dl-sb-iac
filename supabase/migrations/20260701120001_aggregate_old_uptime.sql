-- Supporting index for per-domain uptime range scans (reads and cleanup)
create index if not exists idx_uptime_domain_id_checked_at
  on public.uptime using btree (domain_id, checked_at);

-- Bounded, idempotent uptime aggregation
--
-- Collapses each day older than the cutoff that still has more than one record
-- into a single averaged row (at noon that day), and deletes the raw checks.
-- Days already reduced to one row are skipped (having count(*) > 1), so a day is
-- only ever processed once and storage stays bounded to one row per day. Runs
-- set-based across all domains in a single statement, so there is no per-row
-- loop and no row-capped domain discovery. Returns the number of raw rows removed.
--
-- The insert and delete share one snapshot, so the delete cannot see the freshly
-- inserted aggregate and only removes the original raw rows.
create or replace function public.aggregate_old_uptime(cutoff_time timestamptz)
returns integer
language plpgsql
set search_path to 'public'
set timezone to 'UTC'
as $$
declare
  removed integer;
begin
  with daily as (
    select
      domain_id,
      date_trunc('day', checked_at) as day_start,
      (avg(case when is_up then 1.0 else 0.0 end) > 0.5) as is_up,
      round(avg(response_time_ms)) as response_time_ms,
      round(avg(dns_lookup_time_ms)) as dns_time_ms,
      round(avg(ssl_handshake_time_ms)) as ssl_time_ms
    from uptime
    where checked_at < cutoff_time
    group by domain_id, date_trunc('day', checked_at)
    having count(*) > 1
  ),
  ins as (
    insert into uptime (
      domain_id, checked_at, is_up, response_code,
      response_time_ms, dns_lookup_time_ms, ssl_handshake_time_ms
    )
    select
      domain_id, day_start + interval '12 hours', is_up, 200,
      response_time_ms, dns_time_ms, ssl_time_ms
    from daily
  ),
  del as (
    delete from uptime u
    using daily d
    where u.domain_id = d.domain_id
      and u.checked_at >= d.day_start
      and u.checked_at < d.day_start + interval '1 day'
    returning u.id
  )
  select count(*)::integer into removed from del;

  return removed;
end;
$$;

revoke all on function public.aggregate_old_uptime(timestamptz) from public;
grant execute on function public.aggregate_old_uptime(timestamptz) to service_role;
