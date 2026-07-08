

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgsodium" WITH SCHEMA "pgsodium";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "http" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgjwt" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "wrappers" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."delete_domain"("domain_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
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
END;$_$;


ALTER FUNCTION "public"."delete_domain"("domain_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_domain_uptime"("user_id" "uuid", "domain_id" "uuid", "timeframe" "text") RETURNS TABLE("checked_at" timestamp with time zone, "is_up" boolean, "response_code" integer, "response_time_ms" numeric, "dns_lookup_time_ms" numeric, "ssl_handshake_time_ms" numeric)
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $_$
declare
  time_interval text;
begin
  -- Map the timeframe to an interval
  if timeframe = 'day' then
    time_interval := '1 day';
  elsif timeframe = 'week' then
    time_interval := '1 week';
  elsif timeframe = 'month' then
    time_interval := '1 month';
  elsif timeframe = 'year' then
    time_interval := '1 year';
  else
    time_interval := '1 day';
  end if;

  -- Fetch data filtered by user ownership, domain ID, and interval
  return query
    select
      u.checked_at,
      u.is_up,
      u.response_code,
      u.response_time_ms,
      u.dns_lookup_time_ms,
      u.ssl_handshake_time_ms
    from
      uptime u
    join
      domains d on u.domain_id = d.id
    where
      d.user_id = $1 -- Explicitly refer to the function parameter
      and u.domain_id = $2
      and u.checked_at >= now() - cast(time_interval as interval)
    order by
      u.checked_at;
end;
$_$;


ALTER FUNCTION "public"."get_domain_uptime"("user_id" "uuid", "domain_id" "uuid", "timeframe" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_domains_by_epp_status_codes"("status_codes" "text"[]) RETURNS TABLE("status_code" "text", "domain_id" "uuid", "domain_name" "text")
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    domain_statuses.status_code,
    domain_statuses.domain_id,
    domains.domain_name  -- Assuming the domain name is stored in the domains table
  FROM 
    domain_statuses
  JOIN 
    domains ON domain_statuses.domain_id = domains.id
  WHERE 
    domain_statuses.status_code = ANY(status_codes)
  ORDER BY 
    domain_statuses.status_code;
END;
$$;


ALTER FUNCTION "public"."get_domains_by_epp_status_codes"("status_codes" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ip_addresses_with_domains"("p_is_ipv6" boolean) RETURNS TABLE("ip_address" "inet", "domains" "text"[])
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ip.ip_address::inet,
    array_agg(DISTINCT d.domain_name) AS domains
  FROM 
    ip_addresses ip
    JOIN domains d ON ip.domain_id = d.id
  WHERE
    d.user_id = auth.uid()
    AND ip.is_ipv6 = p_is_ipv6
  GROUP BY 
    ip.ip_address
  ORDER BY 
    ip.ip_address;
END;
$$;


ALTER FUNCTION "public"."get_ip_addresses_with_domains"("p_is_ipv6" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ssl_issuers_with_domain_counts"() RETURNS TABLE("issuer" "text", "domain_count" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    sc.issuer,
    COUNT(DISTINCT d.id) AS domain_count
  FROM 
    ssl_certificates sc
    JOIN domains d ON sc.domain_id = d.id
  WHERE
    d.user_id = auth.uid()
  GROUP BY 
    sc.issuer
  ORDER BY 
    domain_count DESC;
END;
$$;


ALTER FUNCTION "public"."get_ssl_issuers_with_domain_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_statuses_with_domain_counts"() RETURNS TABLE("status_code" "text", "domain_count" bigint)
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    domain_statuses.status_code,
    COUNT(domain_statuses.domain_id) AS domain_count
  FROM 
    domain_statuses
  GROUP BY 
    domain_statuses.status_code
  ORDER BY 
    domain_count DESC;
END;
$$;


ALTER FUNCTION "public"."get_statuses_with_domain_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_user_id_on_hosts"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.user_id := auth.uid();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_user_id_on_hosts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_user_id_on_registrars"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.user_id := auth.uid();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_user_id_on_registrars"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_send_notification"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    notification_json jsonb;
    request_url text := 'https://domain-locker.supabase.co/functions/v1/send-notification';
begin
    -- Ensure schema is explicitly referenced
    set search_path to public;

    -- Build the JSON payload
    notification_json := jsonb_build_object(
        'message', NEW.message,
        'userId', NEW.user_id
    );

    -- Call the Supabase function to send the notification
    perform http_post(request_url, notification_json);

    -- Mark notification as sent
    update public.notifications
    set sent = true
    where id = NEW.id;

    return NEW;
end;
$$;


ALTER FUNCTION "public"."trigger_send_notification"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."billing" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "current_plan" "text" NOT NULL,
    "next_payment_due" timestamp with time zone,
    "billing_method" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "meta" "jsonb",
    CONSTRAINT "billing_current_plan_check" CHECK (("current_plan" = ANY (ARRAY['free'::"text", 'hobby'::"text", 'pro'::"text", 'enterprise'::"text", 'sponsor'::"text", 'complimentary'::"text", 'tester'::"text", 'demo'::"text", 'super'::"text"])))
);


ALTER TABLE "public"."billing" OWNER TO "postgres";


COMMENT ON COLUMN "public"."billing"."meta" IS 'Optional metadata from a subscription';



CREATE TABLE IF NOT EXISTS "public"."dns_records" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "domain_id" "uuid" NOT NULL,
    "record_type" "text" NOT NULL,
    "record_value" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE "public"."dns_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."domain_costings" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "domain_id" "uuid" NOT NULL,
    "purchase_price" numeric(10,2) DEFAULT 0,
    "current_value" numeric(10,2) DEFAULT 0,
    "renewal_cost" numeric(10,2) DEFAULT 0,
    "auto_renew" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE "public"."domain_costings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."domain_hosts" (
    "domain_id" "uuid" NOT NULL,
    "host_id" "uuid" NOT NULL
);


ALTER TABLE "public"."domain_hosts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."domain_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "domain_id" "uuid",
    "link_name" "text" NOT NULL,
    "link_url" "text" NOT NULL,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"(),
    "link_description" "text"
);


ALTER TABLE "public"."domain_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."domain_statuses" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "domain_id" "uuid" NOT NULL,
    "status_code" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE "public"."domain_statuses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."domain_tags" (
    "domain_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL
);


ALTER TABLE "public"."domain_tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."domain_updates" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "domain_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "change" "text" NOT NULL,
    "change_type" "text" NOT NULL,
    "old_value" "text",
    "new_value" "text",
    "date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE "public"."domain_updates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."domains" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "domain_name" "text" NOT NULL,
    "expiry_date" "date",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "registrar_id" "uuid",
    "registration_date" timestamp with time zone,
    "updated_date" timestamp with time zone
);


ALTER TABLE "public"."domains" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hosts" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "ip" "inet" NOT NULL,
    "lat" numeric,
    "lon" numeric,
    "isp" "text",
    "org" "text",
    "as_number" "text",
    "city" "text",
    "region" "text",
    "country" "text",
    "user_id" "uuid" NOT NULL
);


ALTER TABLE "public"."hosts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ip_addresses" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "domain_id" "uuid" NOT NULL,
    "ip_address" "inet" NOT NULL,
    "is_ipv6" boolean NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE "public"."ip_addresses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "domain_id" "uuid" NOT NULL,
    "notification_type" "text" NOT NULL,
    "is_enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "domain_id" "uuid" NOT NULL,
    "change_type" "text" NOT NULL,
    "message" "text",
    "sent" boolean DEFAULT false NOT NULL,
    "read" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."registrars" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "url" "text",
    "user_id" "uuid"
);


ALTER TABLE "public"."registrars" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ssl_certificates" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "domain_id" "uuid" NOT NULL,
    "issuer" "text",
    "issuer_country" "text",
    "subject" "text",
    "valid_from" "date",
    "valid_to" "date",
    "fingerprint" "text",
    "key_size" integer,
    "signature_algorithm" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE "public"."ssl_certificates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_domains" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "domain_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "sd_info" "jsonb"
);


ALTER TABLE "public"."sub_domains" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "color" "text",
    "description" "text",
    "icon" "text",
    "user_id" "uuid" NOT NULL
);


ALTER TABLE "public"."tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."uptime" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "domain_id" "uuid" NOT NULL,
    "checked_at" timestamp with time zone DEFAULT "now"(),
    "is_up" boolean NOT NULL,
    "response_code" integer,
    "response_time_ms" numeric,
    "dns_lookup_time_ms" numeric,
    "ssl_handshake_time_ms" numeric,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE "public"."uptime" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_info" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "notification_channels" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "current_plan" "text" DEFAULT 'free'::"text"
);

ALTER TABLE ONLY "public"."user_info" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_info" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."whois_info" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "domain_id" "uuid" NOT NULL,
    "country" "text",
    "state" "text",
    "name" "text",
    "organization" "text",
    "street" "text",
    "city" "text",
    "postal_code" "text"
);


ALTER TABLE "public"."whois_info" OWNER TO "postgres";


ALTER TABLE ONLY "public"."billing"
    ADD CONSTRAINT "billing_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing"
    ADD CONSTRAINT "billing_user_id_unique" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."dns_records"
    ADD CONSTRAINT "dns_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."domain_costings"
    ADD CONSTRAINT "domain_costings_domain_id_unique" UNIQUE ("domain_id");



ALTER TABLE ONLY "public"."domain_costings"
    ADD CONSTRAINT "domain_costings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."domain_hosts"
    ADD CONSTRAINT "domain_hosts_pkey" PRIMARY KEY ("domain_id", "host_id");



ALTER TABLE ONLY "public"."domain_statuses"
    ADD CONSTRAINT "domain_statuses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."domain_tags"
    ADD CONSTRAINT "domain_tags_pkey" PRIMARY KEY ("domain_id", "tag_id");



ALTER TABLE ONLY "public"."domain_updates"
    ADD CONSTRAINT "domain_updates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."domains"
    ADD CONSTRAINT "domains_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."domains"
    ADD CONSTRAINT "domains_user_id_domain_name_key" UNIQUE ("user_id", "domain_name");



ALTER TABLE ONLY "public"."hosts"
    ADD CONSTRAINT "hosts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hosts"
    ADD CONSTRAINT "hosts_user_id_ip_key" UNIQUE ("user_id", "ip");



ALTER TABLE ONLY "public"."ip_addresses"
    ADD CONSTRAINT "ip_addresses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."domain_links"
    ADD CONSTRAINT "links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notifications_domain_id_notification_type_key" UNIQUE ("domain_id", "notification_type");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey1" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."registrars"
    ADD CONSTRAINT "registrars_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."registrars"
    ADD CONSTRAINT "registrars_user_id_name_key" UNIQUE ("user_id", "name");



ALTER TABLE ONLY "public"."ssl_certificates"
    ADD CONSTRAINT "ssl_certificates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_domains"
    ADD CONSTRAINT "sub_domains_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_info"
    ADD CONSTRAINT "unique_user_id" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."uptime"
    ADD CONSTRAINT "uptime_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_info"
    ADD CONSTRAINT "user_info_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whois_info"
    ADD CONSTRAINT "whois_info_domain_id_key" UNIQUE ("domain_id");



ALTER TABLE ONLY "public"."whois_info"
    ADD CONSTRAINT "whois_info_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_billing_user_id" ON "public"."billing" USING "btree" ("user_id");



CREATE INDEX "idx_dns_records_domain_id" ON "public"."dns_records" USING "btree" ("domain_id");



CREATE INDEX "idx_domain_hosts_domain_id" ON "public"."domain_hosts" USING "btree" ("domain_id");



CREATE INDEX "idx_domain_hosts_host_id" ON "public"."domain_hosts" USING "btree" ("host_id");



CREATE INDEX "idx_domain_updates_user_id" ON "public"."domain_updates" USING "btree" ("user_id");



CREATE INDEX "idx_domains_registrar_id" ON "public"."domains" USING "btree" ("registrar_id");



CREATE INDEX "idx_domains_user_id" ON "public"."domains" USING "btree" ("user_id");



CREATE INDEX "idx_hosts_user_id" ON "public"."hosts" USING "btree" ("user_id");



CREATE INDEX "idx_ip_addresses_domain_id" ON "public"."ip_addresses" USING "btree" ("domain_id");



CREATE INDEX "idx_notifications_domain_id" ON "public"."notification_preferences" USING "btree" ("domain_id");



CREATE INDEX "idx_notifications_user_id_domain_id" ON "public"."notifications" USING "btree" ("user_id", "domain_id");



CREATE INDEX "idx_ssl_certificates_domain_id" ON "public"."ssl_certificates" USING "btree" ("domain_id");



CREATE INDEX "sub_domains_domain_id_name_idx" ON "public"."sub_domains" USING "btree" ("domain_id", "name");



CREATE OR REPLACE TRIGGER "send_unsent_notifications" AFTER INSERT ON "public"."notifications" FOR EACH ROW WHEN ((("new"."sent" = false) AND ("new"."read" = false))) EXECUTE FUNCTION "public"."trigger_send_notification"();



CREATE OR REPLACE TRIGGER "trigger_set_user_id_on_hosts" BEFORE INSERT ON "public"."hosts" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_id_on_hosts"();



CREATE OR REPLACE TRIGGER "trigger_set_user_id_on_registrars" BEFORE INSERT ON "public"."registrars" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_id_on_registrars"();



ALTER TABLE ONLY "public"."billing"
    ADD CONSTRAINT "billing_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dns_records"
    ADD CONSTRAINT "dns_records_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id");



ALTER TABLE ONLY "public"."domain_costings"
    ADD CONSTRAINT "domain_costings_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."domain_hosts"
    ADD CONSTRAINT "domain_hosts_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id");



ALTER TABLE ONLY "public"."domain_hosts"
    ADD CONSTRAINT "domain_hosts_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id");



ALTER TABLE ONLY "public"."domain_statuses"
    ADD CONSTRAINT "domain_statuses_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."domain_tags"
    ADD CONSTRAINT "domain_tags_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id");



ALTER TABLE ONLY "public"."domain_tags"
    ADD CONSTRAINT "domain_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id");



ALTER TABLE ONLY "public"."domain_updates"
    ADD CONSTRAINT "domain_updates_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."domain_updates"
    ADD CONSTRAINT "domain_updates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."domains"
    ADD CONSTRAINT "domains_registrar_id_fkey" FOREIGN KEY ("registrar_id") REFERENCES "public"."registrars"("id");



ALTER TABLE ONLY "public"."domains"
    ADD CONSTRAINT "domains_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."hosts"
    ADD CONSTRAINT "fk_hosts_user_id" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."ip_addresses"
    ADD CONSTRAINT "ip_addresses_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id");



ALTER TABLE ONLY "public"."domain_links"
    ADD CONSTRAINT "links_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notifications_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_domain_id_fkey1" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id");



ALTER TABLE ONLY "public"."registrars"
    ADD CONSTRAINT "registrars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ssl_certificates"
    ADD CONSTRAINT "ssl_certificates_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id");



ALTER TABLE ONLY "public"."sub_domains"
    ADD CONSTRAINT "sub_domains_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."uptime"
    ADD CONSTRAINT "uptime_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_info"
    ADD CONSTRAINT "user_info_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."whois_info"
    ADD CONSTRAINT "whois_info_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id");



CREATE POLICY "Allow user to read their billing info" ON "public"."billing" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow users to update their notifications" ON "public"."notifications" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Authenticated users can add hosts" ON "public"."hosts" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Enable read access for service role" ON "public"."user_info" FOR SELECT TO "service_role" USING (true);



CREATE POLICY "Prevent user from deleting billing info" ON "public"."billing" FOR DELETE USING (false);



CREATE POLICY "Prevent user from inserting billing info" ON "public"."billing" FOR INSERT WITH CHECK (false);



CREATE POLICY "Prevent user from updating billing info" ON "public"."billing" FOR UPDATE USING (false);



CREATE POLICY "Users can delete their own hosts" ON "public"."hosts" FOR DELETE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can edit their own hosts" ON "public"."hosts" FOR UPDATE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can read their own hosts" ON "public"."hosts" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."billing" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "delete_domain_hosts_policy" ON "public"."domain_hosts" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_hosts"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



CREATE POLICY "delete_own_registrars" ON "public"."registrars" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "delete_sub_domains_policy" ON "public"."sub_domains" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "sub_domains"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



CREATE POLICY "delete_tags" ON "public"."tags" USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dns_records" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dns_records_policy" ON "public"."dns_records" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "dns_records"."domain_id") AND ("domains"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "dns_records"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."domain_costings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "domain_costings_policy" ON "public"."domain_costings" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_costings"."domain_id") AND ("domains"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_costings"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."domain_hosts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "domain_hosts_policy" ON "public"."domain_hosts" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_hosts"."domain_id") AND ("domains"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_hosts"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."domain_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."domain_statuses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "domain_statuses_policy" ON "public"."domain_statuses" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_statuses"."domain_id") AND ("domains"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_statuses"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."domain_tags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "domain_tags_policy" ON "public"."domain_tags" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_tags"."domain_id") AND ("domains"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_tags"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."domain_updates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."domains" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "domains_policy" ON "public"."domains" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."hosts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insert_domain_hosts_policy" ON "public"."domain_hosts" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_hosts"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



CREATE POLICY "insert_domain_updates" ON "public"."domain_updates" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "insert_notifications_policy" ON "public"."notifications" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "insert_own_hosts" ON "public"."hosts" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) OR ("user_id" IS NULL)));



CREATE POLICY "insert_own_registrars" ON "public"."registrars" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "insert_sub_domains_policy" ON "public"."sub_domains" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "sub_domains"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



CREATE POLICY "insert_tags" ON "public"."tags" WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."ip_addresses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ip_addresses_policy" ON "public"."ip_addresses" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "ip_addresses"."domain_id") AND ("domains"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "ip_addresses"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



CREATE POLICY "manage_own_links" ON "public"."domain_links" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_links"."domain_id") AND ("domains"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_links"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



CREATE POLICY "modify_own_info" ON "public"."user_info" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_policy" ON "public"."notification_preferences" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "notification_preferences"."domain_id") AND ("domains"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "notification_preferences"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."registrars" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "select_domain_hosts_policy" ON "public"."domain_hosts" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_hosts"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



CREATE POLICY "select_domain_updates" ON "public"."domain_updates" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "select_notifications_policy" ON "public"."notifications" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "select_own_info" ON "public"."user_info" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "select_own_links" ON "public"."domain_links" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "domain_links"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



CREATE POLICY "select_own_registrars" ON "public"."registrars" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "select_sub_domains_policy" ON "public"."sub_domains" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "sub_domains"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



CREATE POLICY "select_tags" ON "public"."tags" USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."ssl_certificates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ssl_certificates_policy" ON "public"."ssl_certificates" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "ssl_certificates"."domain_id") AND ("domains"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "ssl_certificates"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."sub_domains" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "update_own_registrars" ON "public"."registrars" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "update_sub_domains_policy" ON "public"."sub_domains" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "sub_domains"."domain_id") AND ("domains"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "sub_domains"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



CREATE POLICY "update_tags" ON "public"."tags" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."uptime" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "uptime_modify_policy" ON "public"."uptime" USING (false) WITH CHECK (false);



CREATE POLICY "uptime_select_policy" ON "public"."uptime" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "uptime"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."user_info" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."whois_info" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "whois_info_policy" ON "public"."whois_info" USING ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "whois_info"."domain_id") AND ("domains"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."domains"
  WHERE (("domains"."id" = "whois_info"."domain_id") AND ("domains"."user_id" = "auth"."uid"())))));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";








GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



































































































































































































































































































































































































REVOKE ALL ON FUNCTION "public"."delete_domain"("domain_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_domain"("domain_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_domain"("domain_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_domain_uptime"("user_id" "uuid", "domain_id" "uuid", "timeframe" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_domain_uptime"("user_id" "uuid", "domain_id" "uuid", "timeframe" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_domain_uptime"("user_id" "uuid", "domain_id" "uuid", "timeframe" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_domains_by_epp_status_codes"("status_codes" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_domains_by_epp_status_codes"("status_codes" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_domains_by_epp_status_codes"("status_codes" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_ip_addresses_with_domains"("p_is_ipv6" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."get_ip_addresses_with_domains"("p_is_ipv6" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_ip_addresses_with_domains"("p_is_ipv6" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_ssl_issuers_with_domain_counts"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_ssl_issuers_with_domain_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_ssl_issuers_with_domain_counts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_statuses_with_domain_counts"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_statuses_with_domain_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_statuses_with_domain_counts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_user_id_on_hosts"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_user_id_on_hosts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_user_id_on_hosts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_user_id_on_registrars"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_user_id_on_registrars"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_user_id_on_registrars"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_send_notification"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_send_notification"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_send_notification"() TO "service_role";






























GRANT ALL ON TABLE "public"."billing" TO "anon";
GRANT ALL ON TABLE "public"."billing" TO "authenticated";
GRANT ALL ON TABLE "public"."billing" TO "service_role";



GRANT ALL ON TABLE "public"."dns_records" TO "anon";
GRANT ALL ON TABLE "public"."dns_records" TO "authenticated";
GRANT ALL ON TABLE "public"."dns_records" TO "service_role";



GRANT ALL ON TABLE "public"."domain_costings" TO "anon";
GRANT ALL ON TABLE "public"."domain_costings" TO "authenticated";
GRANT ALL ON TABLE "public"."domain_costings" TO "service_role";



GRANT ALL ON TABLE "public"."domain_hosts" TO "anon";
GRANT ALL ON TABLE "public"."domain_hosts" TO "authenticated";
GRANT ALL ON TABLE "public"."domain_hosts" TO "service_role";



GRANT ALL ON TABLE "public"."domain_links" TO "anon";
GRANT ALL ON TABLE "public"."domain_links" TO "authenticated";
GRANT ALL ON TABLE "public"."domain_links" TO "service_role";



GRANT ALL ON TABLE "public"."domain_statuses" TO "anon";
GRANT ALL ON TABLE "public"."domain_statuses" TO "authenticated";
GRANT ALL ON TABLE "public"."domain_statuses" TO "service_role";



GRANT ALL ON TABLE "public"."domain_tags" TO "anon";
GRANT ALL ON TABLE "public"."domain_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."domain_tags" TO "service_role";



GRANT ALL ON TABLE "public"."domain_updates" TO "anon";
GRANT ALL ON TABLE "public"."domain_updates" TO "authenticated";
GRANT ALL ON TABLE "public"."domain_updates" TO "service_role";



GRANT ALL ON TABLE "public"."domains" TO "anon";
GRANT ALL ON TABLE "public"."domains" TO "authenticated";
GRANT ALL ON TABLE "public"."domains" TO "service_role";



GRANT ALL ON TABLE "public"."hosts" TO "anon";
GRANT ALL ON TABLE "public"."hosts" TO "authenticated";
GRANT ALL ON TABLE "public"."hosts" TO "service_role";



GRANT ALL ON TABLE "public"."ip_addresses" TO "anon";
GRANT ALL ON TABLE "public"."ip_addresses" TO "authenticated";
GRANT ALL ON TABLE "public"."ip_addresses" TO "service_role";



GRANT ALL ON TABLE "public"."notification_preferences" TO "anon";
GRANT ALL ON TABLE "public"."notification_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."registrars" TO "anon";
GRANT ALL ON TABLE "public"."registrars" TO "authenticated";
GRANT ALL ON TABLE "public"."registrars" TO "service_role";



GRANT ALL ON TABLE "public"."ssl_certificates" TO "anon";
GRANT ALL ON TABLE "public"."ssl_certificates" TO "authenticated";
GRANT ALL ON TABLE "public"."ssl_certificates" TO "service_role";



GRANT ALL ON TABLE "public"."sub_domains" TO "anon";
GRANT ALL ON TABLE "public"."sub_domains" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_domains" TO "service_role";



GRANT ALL ON TABLE "public"."tags" TO "anon";
GRANT ALL ON TABLE "public"."tags" TO "authenticated";
GRANT ALL ON TABLE "public"."tags" TO "service_role";



GRANT ALL ON TABLE "public"."uptime" TO "anon";
GRANT ALL ON TABLE "public"."uptime" TO "authenticated";
GRANT ALL ON TABLE "public"."uptime" TO "service_role";



GRANT ALL ON TABLE "public"."user_info" TO "anon";
GRANT ALL ON TABLE "public"."user_info" TO "authenticated";
GRANT ALL ON TABLE "public"."user_info" TO "service_role";



GRANT ALL ON TABLE "public"."whois_info" TO "anon";
GRANT ALL ON TABLE "public"."whois_info" TO "authenticated";
GRANT ALL ON TABLE "public"."whois_info" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "service_role";






























RESET ALL;
