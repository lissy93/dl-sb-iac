-- Aggregate only complete days of uptime checks
--
-- The cutoff carries a time of day, but the delete removed whole calendar days, so
-- checks after the cutoff on that day were dropped without being averaged. Truncating
-- the cutoff to the start of its day means every processed day is complete, matching
-- the self-hosted aggregation. Ownership and grants carry over from the original.

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
    where checked_at < date_trunc('day', cutoff_time)
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
