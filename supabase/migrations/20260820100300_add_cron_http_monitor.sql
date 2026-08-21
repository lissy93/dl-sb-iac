-- Alert on failing cron HTTP calls
--
-- cron.job_run_details reports success as soon as pg_net queues a request, so HTTP
-- failures are invisible there. net._http_response holds the real outcome, which is
-- how the three-day Edge Functions outage went unnoticed. Requires a vault secret
-- `hc_url` and a healthchecks.io check named `cron-http-failures`; it no-ops safely
-- until the secret exists.

create or replace function public.check_cron_http_health()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hc_url text;
  failures int;
begin
  select decrypted_secret into hc_url
    from vault.decrypted_secrets where name = 'hc_url';
  if hc_url is null then return; end if;

  select count(*) into failures
    from net._http_response
   where created > now() - interval '20 minutes'
     and (status_code is null or status_code not between 200 and 299);

  perform net.http_post(
    url := hc_url || '/cron-http-failures' ||
           case when failures > 0 then '/fail' else '' end,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('failures', failures),
    timeout_milliseconds := 5000
  );
exception when others then
  raise warning 'check_cron_http_health failed: %', sqlerrm;
end;
$$;

revoke all on function public.check_cron_http_health() from public, anon, authenticated;
grant execute on function public.check_cron_http_health() to service_role;

select cron.schedule(
  'check-cron-http-health', '*/15 * * * *',
  $$ select public.check_cron_http_health(); $$
);
