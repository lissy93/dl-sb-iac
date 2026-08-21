-- Fix the new-user billing trigger
--
-- It posted to a hardcoded host with no Authorization header, so every call was
-- rejected and surfaced as a 500. It also ran on every sign-in, which would mean
-- two external API calls per login now that the calls actually succeed; the daily
-- cron already re-checks existing users, so only users without a billing row are
-- sent. The http_post is guarded so a failure can never block authentication.

create or replace function public.trigger_setup_user_billing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  project_url text;
  svc_jwt text;
begin
  if exists (select 1 from public.billing where user_id = new.id) then
    return new;
  end if;

  select decrypted_secret into project_url
    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into svc_jwt
    from vault.decrypted_secrets where name = 'service_key';

  if project_url is null or svc_jwt is null then
    raise warning 'Billing setup skipped for %: missing vault secrets', new.id;
    return new;
  end if;

  begin
    perform net.http_post(
      url := project_url || '/functions/v1/new-user-billing',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || svc_jwt
      ),
      body := jsonb_build_object('userId', new.id),
      timeout_milliseconds := 5000
    );
  exception when others then
    raise warning 'Billing setup call failed for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;
