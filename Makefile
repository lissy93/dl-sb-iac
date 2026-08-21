.PHONY: all seed secrets config schema functions deploy check test

# Define variables for commands to avoid repetition
SUPABASE=npx supabase

all: deploy

seed:
	@echo "🌱 Seeding database"
	@$(SUPABASE) seed buckets || echo "No buckets to seed, skipping..."

secrets:
	@echo "🔐 Setting secrets"
	@test -f .env && $(SUPABASE) secrets set --env-file .env || echo "No .env file found, skipping..."

config:
	@echo "⚙️ Applying configuration"
	@$(SUPABASE) config push --yes

schema:
	@echo "🚀 Deploying database schema"
	@$(SUPABASE) db push

check:
	@echo "🔎 Type-checking Edge Functions"
	@deno check supabase/functions/*/index.ts

test:
	@echo "🧪 Running tests"
	@deno test --allow-net --allow-env tests/

functions:
	@echo "⚡ Deploying Edge Functions"
	@$(SUPABASE) functions deploy

deploy: schema seed functions secrets config

help:
	@echo "Available targets:"
	@echo "  all       - Run the deploy target"
	@echo "  seed      - Seed the database"
	@echo "  secrets   - Set secrets from environment"
	@echo "  config    - Apply configuration"
	@echo "  schema    - Deploy database schema"
	@echo "  functions - Deploy Edge Functions"
	@echo "  check     - Type-check Edge Functions"
	@echo "  test      - Run tests"
	@echo "  deploy    - Run schema, seed, functions, secrets, and config targets"
	@echo "  help      - Show this help message"
