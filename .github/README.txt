
       ____                        _         _               _
      |  _ \  ___  _ __ ___   __ _(_)_ __   | |    ___   ___| | _____ _ __
      | | | |/ _ \| '_ ` _ \ / _` | | '_ \  | |   / _ \ / __| |/ / _ \ '__|
      | |_| | (_) | | | | | | (_| | | | | | | |__| (_) | (__|   <  __/ |
      |____/ \___/|_| |_| |_|\__,_|_|_| |_| |_____\___/ \___|_|\_\___|_|


>> This repo contains the config, schema and edge functions for Domain Locker <<
>> For the main project and app, see https://github.com/lissy93/domain-locker <<

================================================================================
DIRECTORY STRUCTURE
================================================================================
domain-locker-edge/
├─ supabase/
│  ├─ functions/      # Deno Edge functions
│  │  ├─ [function]/  # Directory for each function
│  │  │  ╰─ index.ts  # Entry point for the function
│  │  ╰─ shared/      # Utilities for edge functions
│  ├─ migrations/     # Database schema
│  ├─ templates/      # Mailer templates
│  ╰─ config.toml     # Supabase configuration
├─ .github/           # Repo admin, and GH Actions
│  ├─ workflows/      # CI/CD files for deployment
│  ╰─ README.txt      # You're looking at it ;)
├─ Makefile           # Project commands
├─ deno.json          # Deno project config
╰─ .gitignore         # Stuff to not commit

================================================================================
DEVELOPING
================================================================================
Pre-requisites:
  - Install Git, Deno, Supabase CLI, Postgres and Docker on your local machine
  - Deploy a Supabase instance. See https://supabase.io/docs/guides/self-hosting
  - Configure all the required environmental variables for services (see below)

Project setup:
  git clone git@github.com:Lissy93/domain-locker-edge.git
  supabase link --project-ref PROJECT_REF

Development:
  supabase start
  supabase status
  supabase functions serve

================================================================================
DEPLOYING
================================================================================
supabase secrets set-from-env   # Set environments
supabase config push            # Apply configuration
supabase db push                # Deploy schema
supabase functions deploy       # Deploy functions

See the `Makefile` for all deployment commands.

The easiest way to deploy is via GitHub Actions, which we use for CI/CD.
Just push to main or trigger the supabase.yml workflow, and it will deploy

You'll need to configure the following GitHub secrets to authenticate:
  SUPABASE_PROJECT_ID     - The Supabase project ID
  SUPABASE_ACCESS_TOKEN   - The Supabase access token
  SUPABASE_DB_PASSWORD    - The Postgres password for your Supabase DB
  SUPABASE_ENV_FILE       - Raw text env vars for all else you need (see below)

================================================================================
FUNCTIONS
================================================================================
Stripe and Billing:
- cancel-subscription   Cancels a user's subscription
- checkout-session      Creates a new checkout session for a subscription
- stripe-webhook        Handles incoming events triggered from Stripe
- new-user-billing      Create/updates Stripe customer, and applies user plan
- stripe-details        Fetches Stripe billing and customer details for a user

User Management:
- delete-account        Deletes a user account and all associated data
- export-data           Exports all (selected) data for a user in a given format

Domain Management:
- trigger-updates       Selects domains for users, and triggers domain-updater
- domain-updater        Updates domains with latest info, triggers notifications
- send-notification     Sends a notification to user id with message
- website-monitor       Gets response info for each (pro) domain, updates db
- expiration-invites    Creates a calendar invite 90 days before domain expiry
- expiration-reminders  Triggers reminders for upcoming domain expirations

Maintenance:
- cleanup-monitor-data  Averages historic data from website monitoring
- cleanup-notifications Ensures notifications have been sent, removes old ones
- health                Checks system health, returns service statuses

Info Routes:
- domain-info           Fetches all info for any given domain name
- domain-subs           Fetches all subdomains for any given domain


================================================================================
UTILITIES
================================================================================
There's some shared utils that all/most the functions use, these are:

- logger
  - For consistent logging, with different levels (info, warn, error)
  - Can integrate with external logging services for better monitoring
  - Can report error logs to GlitchTip/Sentry or other error tracking
- monitor
  - Monitors function duration and status
  - If `X-Cron-Run` header is set, will send to Healthcheck for cron monitoring
  - Can integrate with external monitoring services for better insights
- serveWithCors
  - Wraps Deno HTTP server, but with shared headers and config set
  - Handles CORS preflight requests, using `APP_ORIGIN` for allowed domains
  - Throws suitable error for unauthorized, unsupported or bad requests
- supabaseClient
  - Provides a shared Supabase client for functions
  - Handles authentication and authorization for user requests
  - Uses the JWT from bearer token to apply correct permissions and RLS

================================================================================
ENVIRONMENT VARIABLES
================================================================================
Supabase:
  DB_URL - The URL to your Supabase instance and project
  DB_KEY - The anon key to your new Supabase project

Config:
  APP_ORIGIN - The origin URL for client-app (for CORS)

Monitoring:
  HC_URL - The URL to the Healthcheck service
  GLITCHTIP_URL - URL to your GlitchTip/Sentry instance
  GLITCHTIP_TOKEN - DSN token for GlitchTip/Sentry
  LOGFLARE_ENDPOINT_URL - The Logflare endpoint URL
  DL_LOGGING_ENABLED - Enable or disable logging

Authentication
  SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID   - Google OAuth Client ID
  SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET      - Google OAuth Secret
  SUPABASE_AUTH_EXTERNAL_FACEBOOK_CLIENT_ID - Facebook OAuth Client ID
  SUPABASE_AUTH_EXTERNAL_FACEBOOK_SECRET    - Facebook OAuth Secret
  SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID   - GitHub OAuth Client ID
  SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET      - GitHub OAuth Secret

API Endpoints:
  AS93_DOMAIN_INFO_URL  - The URL to our external domain info API
  AS93_DOMAIN_INFO_KEY  - And the key for the domain info API
  AS93_SPONSORS_API     - The URL to our GitHub sponsors API

WHOIS Fallbacks (all optional):
  WHO_DAT_URL      - Who-Dat instance URL (default: https://who-dat.as93.net)
  WHO_DAT_API_KEY  - Sent as x-api-key to Who-Dat, so you can skip rate limit
  WHOISXML_API_KEY - Enables WhoisXML API as a last-resort paid fallback

Worker Endpoints:
  WORKER_DOMAIN_UPDATER_URL - The URL to domain-updater function
  WORKER_SEND_NOTIFICATION_URL - The URL to send-notification function

Stripe:
  STRIPE_SECRET_KEY - Stripe secret key (starting with sk_live_ or sk_test_)
  STRIPE_WEBHOOK_SECRET - Stripe webhook secret (starting with whsec_)

Stripe Prices:
  STRIPE_PRICE_HM - Stripe price ID for the hobby monthly plan (starting price_)
  STRIPE_PRICE_HA - Price ID for the hobby annual plan
  STRIPE_PRICE_PM - Price ID for the pro monthly plan
  STRIPE_PRICE_PA - Price ID for the pro annual plan

Resend:
  RESEND_API_KEY - The API key for the Resend service (send access)
  RESEND_SENDER - The sender email for Resend

Twilio:
  TWILIO_SID - Twilio account SID
  TWILIO_AUTH_TOKEN - Twilio auth token
  TWILIO_PHONE_NUMBER - Twilio phone number
  TWILIO_WHATSAPP_NUMBER - Twilio WhatsApp number

Telegram
  TELEGRAM_BOT_TOKEN - The token for the telegram notification bot

It's advisable to use a secret store for this. We use Supabase Vault.
Or, you can pass secrets to Supabase, by running:
  - supabase secrets set --env-file supabase/functions/.env
Or, to edit a single variable:
  - supabase secrets set VAR_NAME=some_value


================================================================================
CRON JOBS
================================================================================
Some functions are triggered at specific times or intervals as scheduled crons
We do this directly from Postgres's pg_cron using the `cron.schedule` function
This is mainly used for keeping data up-to-date, triggering alerts and cleaning

We have the following crons setup with `cron.schedule` function.
- cleanup-monitor-data  (runs daily, e.g. 0 2 * * *)
- new-user-billing      (runs daily, e.g. 0 3 * * *)
- run_domain_update_job (runs daily, e.g. 0 4 * * *)
- cleanup-notifications (runs daily, e.g. 0 5 * * *)
- expiration-invites    (runs daily, e.g. 0 6 * * *)
- expiration-reminders  (runs daily, e.g. 0 7 * * *)
- monitor-uptimes       (runs hourly, e.g. 0 * * * *)

Example SQL to create a cron:
select cron.schedule(
  'cleanup-notifications',
  '0 5 * * *',
  $$
    SELECT net.http_post(
      url := (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'project_url'
      ) || '/functions/v1/cleanup-notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'service_key'
        ),
        'X-Cron-Run', 'true'
      ),
      body := jsonb_build_object('invoked_at', now())
    );
  $$
);

================================================================================
SUPPORT
================================================================================
We do not provide support for this codebase. It is provided as-is.
If you need help, please refer to the official docs for the services used.
We are not accepting feature requests or bug reports (except security issues).

The difficulty of deploying this project is graded at moderate to hard
You'll need a solid understanding of Deno, Supabase, Postgres and Docker

It is also possible to run Domain Locker without Supabase, using Postgres only.

================================================================================
NOTES
================================================================================
For troubleshooting, ensure protocol, method, port, headers and body are correct
You must set and upload ALL environmental variables properly for things to work
Avoid configuring in the Supabase UI, instead update the TOML file and re-deploy

Example CURL request:
  curl -i --location \
    --request POST 'https://[project].supabase.co/functions/v1/hello-world' \
    --header 'Authorization: Bearer xxxxx' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Dino"}'

Or, for local dev, the URL would be: 127.0.0.1:54321/functions/v1/hello-world

It is your responsibility to maintain, secure and backup your Supabase instance

================================================================================
LICENSE
================================================================================
Copyright (c) 2025 Alicia Sykes

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

================================================================================
ABOUT
================================================================================
Coded with ❤ and ♨ by Alicia Sykes                      https://aliciasykes.com
Built for Domain Locker                                https://domain-locker.com

                        Thanks for being here! (●'◡'●)
================================================================================
                                              __
                                             /°_)
                                    _.----._/ /
                                   /         /
                                __/ (  | (  |
                               /__.-'|_|--|_|
