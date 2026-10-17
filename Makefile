# Concord — common commands (macOS and Linux). Run `make help`.
SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: help setup setup-lan up down restart logs ps trust-cert dev test test-backend test-frontend test-webrtc e2e admin admins clean backup install-server

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## Create .env for this computer (http://localhost)
	@./scripts/setup.sh

setup-lan: ## Create .env for other devices in your network (HTTPS on the LAN IP)
	@./scripts/setup.sh --lan

.env:
	@./scripts/setup.sh

up: .env ## Build and start everything in the background
	$(COMPOSE) up --build -d
	@grep -E '^APP_URL=' .env | cut -d= -f2- | sed 's/^/  Open: /'

down: ## Stop all containers (data is kept)
	$(COMPOSE) down

restart: ## Rebuild and restart
	$(COMPOSE) up --build -d --force-recreate

logs: ## Follow logs of all services
	$(COMPOSE) logs -f --tail=100

ps: ## Show container status
	$(COMPOSE) ps

trust-cert: ## Trust the local HTTPS certificate (LAN mode)
	@./scripts/trust-cert.sh

dev: ## Run without Docker (needs local Node 24, PostgreSQL, Redis, livekit-server)
	@./scripts/dev-native.sh

test: test-backend test-frontend ## Unit + API tests

test-backend: ## Backend tests (needs DATABASE_URL pointing to a *_test database and REDIS_URL)
	cd backend && npm test

test-frontend: ## Frontend unit tests
	cd frontend && npm test

test-webrtc: ## Real WebRTC checks in headless Chromium
	cd frontend && npx playwright install chromium && npm run test:webrtc

e2e: ## UI end-to-end tests against the running stack
	cd frontend && npx playwright install chromium && BASE_URL=$$(grep -E '^APP_URL=' ../.env | cut -d= -f2-) SEEDED=1 EXPECT_VOICE=1 npm run test:e2e

admin: ## Make a user platform admin: make admin EMAIL=you@example.com [REVOKE=1]
	@test -n "$(EMAIL)" || { echo 'Usage: make admin EMAIL=you@example.com'; exit 1; }
	$(COMPOSE) exec backend node dist/admin-cli.js $(EMAIL) $(if $(REVOKE),--revoke,)

admins: ## List platform admins
	$(COMPOSE) exec backend node dist/admin-cli.js --list

clean: ## Stop and DELETE all data (database, files, certificates)
	$(COMPOSE) down -v

backup: ## Atomic backup set in ./backups (QUIESCE=1 for a consistent snapshot; briefly stops backend)
	@./scripts/backup.sh $(if $(QUIESCE),--quiesce,)

install-server: ## Install on a Linux VPS (sudo; usage: make install-server DOMAIN=chat.example.com EMAIL=you@example.com)
	sudo ./scripts/install-server.sh $(DOMAIN) $(EMAIL)
