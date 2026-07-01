.PHONY: all seed secrets config schema functions deploy

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
	@echo "  deploy    - Run schema, seed, functions, secrets, and config targets"
	@echo "  help      - Show this help message"
