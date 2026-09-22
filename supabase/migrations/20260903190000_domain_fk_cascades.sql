-- Eight child tables still referenced domains without ON DELETE CASCADE, so any
-- delete not routed through delete_domain() failed on the foreign key. The
-- self-hosted schema cascades all of them; this brings the managed one in line.
-- notification_preferences had its constraint and index named after notifications,
-- so both are renamed to free those names for the real table.

-- The cascade looks children up by domain_id, and notifications only had that
-- column second in a composite index, which a lookup cannot use. Index names are
-- schema-wide, so the misnamed one on notification_preferences must move first
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'notification_preferences'
      AND indexname = 'idx_notifications_domain_id'
  ) THEN
    ALTER INDEX "public"."idx_notifications_domain_id"
      RENAME TO "idx_notification_preferences_domain_id";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_notifications_domain_id"
  ON "public"."notifications" USING "btree" ("domain_id");

ALTER TABLE "public"."dns_records"
  DROP CONSTRAINT IF EXISTS "dns_records_domain_id_fkey",
  ADD CONSTRAINT "dns_records_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "public"."domains"("id") ON DELETE CASCADE;

ALTER TABLE "public"."domain_hosts"
  DROP CONSTRAINT IF EXISTS "domain_hosts_domain_id_fkey",
  ADD CONSTRAINT "domain_hosts_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "public"."domains"("id") ON DELETE CASCADE;

ALTER TABLE "public"."domain_tags"
  DROP CONSTRAINT IF EXISTS "domain_tags_domain_id_fkey",
  ADD CONSTRAINT "domain_tags_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "public"."domains"("id") ON DELETE CASCADE;

ALTER TABLE "public"."ip_addresses"
  DROP CONSTRAINT IF EXISTS "ip_addresses_domain_id_fkey",
  ADD CONSTRAINT "ip_addresses_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "public"."domains"("id") ON DELETE CASCADE;

ALTER TABLE "public"."notifications"
  DROP CONSTRAINT IF EXISTS "notifications_domain_id_fkey",
  DROP CONSTRAINT IF EXISTS "notifications_domain_id_fkey1",
  ADD CONSTRAINT "notifications_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "public"."domains"("id") ON DELETE CASCADE;

ALTER TABLE "public"."notification_preferences"
  DROP CONSTRAINT IF EXISTS "notifications_domain_id_fkey",
  DROP CONSTRAINT IF EXISTS "notification_preferences_domain_id_fkey",
  ADD CONSTRAINT "notification_preferences_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "public"."domains"("id") ON DELETE CASCADE;

ALTER TABLE "public"."ssl_certificates"
  DROP CONSTRAINT IF EXISTS "ssl_certificates_domain_id_fkey",
  ADD CONSTRAINT "ssl_certificates_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "public"."domains"("id") ON DELETE CASCADE;

ALTER TABLE "public"."whois_info"
  DROP CONSTRAINT IF EXISTS "whois_info_domain_id_fkey",
  ADD CONSTRAINT "whois_info_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "public"."domains"("id") ON DELETE CASCADE;
