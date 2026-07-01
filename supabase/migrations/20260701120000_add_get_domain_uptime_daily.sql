-- Add get_domain_uptime_daily: one averaged response time per day
--
-- Additive only. The existing get_domain_uptime (raw checks, used by the
-- sparklines and response-code chart) is left untouched. This function powers
-- the uptime calendar heatmap, returning at most one row per day so a full
-- year fits well under the API row cap and old domains render their history.
create or replace function public.get_domain_uptime_daily(
  user_id uuid,
  domain_id uuid,
  days integer
)
returns table(day date, avg_response_time_ms double precision)
language plpgsql
set search_path to 'public'
as $$
begin
  return query
    select
      (date_trunc('day', u.checked_at))::date as day,
      avg(u.response_time_ms)::double precision as avg_response_time_ms
    from uptime u
    join domains d on u.domain_id = d.id
    where d.user_id = $1
      and u.domain_id = $2
      and u.checked_at >= now() - make_interval(days => $3)
    group by 1
    order by 1;
end;
$$;

alter function public.get_domain_uptime_daily(uuid, uuid, integer) owner to postgres;

grant all on function public.get_domain_uptime_daily(uuid, uuid, integer) to anon;
grant all on function public.get_domain_uptime_daily(uuid, uuid, integer) to authenticated;
grant all on function public.get_domain_uptime_daily(uuid, uuid, integer) to service_role;
