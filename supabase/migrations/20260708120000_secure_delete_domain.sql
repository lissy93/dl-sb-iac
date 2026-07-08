-- Secure delete_domain (audit C1/H1): callers must own the domain (or be the
-- service role), and the orphan cleanup is scoped to the owner so one user's
-- delete can never remove another user's tags, hosts or registrars.

CREATE OR REPLACE FUNCTION public.delete_domain(domain_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  domain_owner uuid;
  caller_role text :=
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
BEGIN
  SELECT d.user_id INTO domain_owner FROM domains d WHERE d.id = $1;
  IF domain_owner IS NULL THEN
    RETURN;
  END IF;

  -- API callers must be the owner or the service role. Direct DB sessions
  -- (no JWT claims) are already privileged and pass through.
  IF caller_role IS NOT NULL AND caller_role <> 'service_role'
     AND domain_owner IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not authorised to delete domain %', $1
      USING ERRCODE = '42501';
  END IF;

  -- Delete related records
  DELETE FROM notifications WHERE notifications.domain_id = $1;
  DELETE FROM ip_addresses WHERE ip_addresses.domain_id = $1;
  DELETE FROM domain_tags WHERE domain_tags.domain_id = $1;
  DELETE FROM notification_preferences WHERE notification_preferences.domain_id = $1;
  DELETE FROM dns_records WHERE dns_records.domain_id = $1;
  DELETE FROM ssl_certificates WHERE ssl_certificates.domain_id = $1;
  DELETE FROM whois_info WHERE whois_info.domain_id = $1;
  DELETE FROM domain_hosts WHERE domain_hosts.domain_id = $1;
  DELETE FROM domain_costings WHERE domain_costings.domain_id = $1;
  DELETE FROM sub_domains WHERE sub_domains.domain_id = $1;

  -- Delete the domain itself
  DELETE FROM domains WHERE domains.id = $1;

  -- Clean up the owner's now-orphaned records. NOT EXISTS (never NOT IN) so
  -- null FKs cannot turn these into no-ops, and rows still referenced by any
  -- domain are always kept.
  DELETE FROM tags t
   WHERE t.user_id = domain_owner
     AND NOT EXISTS (SELECT 1 FROM domain_tags dt WHERE dt.tag_id = t.id);
  DELETE FROM hosts h
   WHERE h.user_id = domain_owner
     AND NOT EXISTS (SELECT 1 FROM domain_hosts dh WHERE dh.host_id = h.id);
  DELETE FROM registrars r
   WHERE r.user_id = domain_owner
     AND NOT EXISTS (SELECT 1 FROM domains d WHERE d.registrar_id = r.id);

  RETURN;
END;$function$;

-- Only authenticated users (owner-checked above) and the service role may call it.
REVOKE EXECUTE ON FUNCTION public.delete_domain(uuid) FROM PUBLIC, anon;
