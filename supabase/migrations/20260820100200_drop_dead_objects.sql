-- Remove objects nothing references
--
-- `trigger_send_notification()` is an orphaned duplicate. The trigger of the same
-- name executes `send_notification_trigger()`; this function is attached to nothing
-- and hardcodes a host rather than reading the vault, so it is a footgun if wired up.
-- No CASCADE, so this fails loudly if anything does depend on it.
drop function if exists public.trigger_send_notification();

-- pgjwt is unused (nothing calls sign/verify/url_encode) and blocks Postgres upgrades
drop extension if exists pgjwt;
