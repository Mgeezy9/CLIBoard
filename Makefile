# Simple Makefile for building and running the CLI runner

SHELL := /bin/bash

# Configurable vars
IMAGE ?= cli-runner:latest
WORKSPACE ?= $(PWD)/cli-runner/volumes/workspace
CREDS ?= $(PWD)/cli-runner/volumes/creds
ENGINE ?= codex

DOCKER ?= docker
COMPOSE ?= docker compose

.PHONY: help build run run-codex run-gemini run-opencode compose-up compose-down compose-codex compose-gemini compose-opencode compose-warm-up compose-warm-down compose-up-light compose-up-standard compose-up-heavy compose-warm-up-light compose-warm-up-standard compose-warm-up-heavy dirs spawner-install spawner-start spawner-dev

help:
	@echo "Targets:"
	@echo "  build            Build image ($(IMAGE))"
	@echo "  run              Run via launcher (ENGINE=$(ENGINE))"
	@echo "  run-codex        Run Codex via launcher"
	@echo "  run-gemini       Run Gemini via launcher"
	@echo "  run-opencode     Run OpenCode via launcher"
	@echo "  compose-up       Up all services (codex/gemini/opencode)"
	@echo "  compose-down     Stop and remove services"
	@echo "  compose-codex    Up only codex service"
	@echo "  compose-gemini   Up only gemini service"
	@echo "  compose-opencode Up only opencode service"
	@echo "  compose-warm-up  Up warm pool (warm-*)"
	@echo "  compose-warm-down Stop warm pool"
	@echo "  compose-up-light  Up with light resource caps"
	@echo "  compose-up-standard Up with standard resource caps"
	@echo "  compose-up-heavy  Up with heavy resource caps"
	@echo "  compose-warm-up-light  Warm pool with light caps"
	@echo "  compose-warm-up-standard Warm pool with standard caps"
	@echo "  compose-warm-up-heavy  Warm pool with heavy caps"
	@echo "  spawner-install   Install Spawner API deps"
	@echo "  spawner-start     Start Spawner API (prod)"
	@echo "  spawner-dev       Start Spawner API (dev)"

dirs:
	mkdir -p "$(WORKSPACE)"
	mkdir -p "$(CREDS)" "$(CREDS)"/codex "$(CREDS)"/gemini "$(CREDS)"/opencode "$(CREDS)"/gcloud

build:
	$(DOCKER) build -t $(IMAGE) cli-runner/docker

run: dirs
	chmod +x cli-runner/host-launch/run.sh
	ENGINE=$(ENGINE) CLI_RUNNER_IMAGE=$(IMAGE) \
		./cli-runner/host-launch/run.sh \
		--engine $(ENGINE) --workspace "$(WORKSPACE)" --creds "$(CREDS)"

run-codex:
	$(MAKE) run ENGINE=codex

run-gemini:
	$(MAKE) run ENGINE=gemini

run-opencode:
	$(MAKE) run ENGINE=opencode

compose-up:
	CLI_RUNNER_IMAGE=$(IMAGE) \
	CODEX_WORKSPACE="$(WORKSPACE)" CODEX_CREDS="$(CREDS)" \
	GEMINI_WORKSPACE="$(WORKSPACE)" GEMINI_CREDS="$(CREDS)" \
	OPENCODE_WORKSPACE="$(WORKSPACE)" OPENCODE_CREDS="$(CREDS)" \
		$(COMPOSE) up --build

compose-down:
	$(COMPOSE) down -v

compose-codex:
	CLI_RUNNER_IMAGE=$(IMAGE) CODEX_WORKSPACE="$(WORKSPACE)" CODEX_CREDS="$(CREDS)" \
		$(COMPOSE) up --build codex

compose-gemini:
	CLI_RUNNER_IMAGE=$(IMAGE) GEMINI_WORKSPACE="$(WORKSPACE)" GEMINI_CREDS="$(CREDS)" \
		$(COMPOSE) up --build gemini

compose-opencode:
	CLI_RUNNER_IMAGE=$(IMAGE) OPENCODE_WORKSPACE="$(WORKSPACE)" OPENCODE_CREDS="$(CREDS)" \
		$(COMPOSE) up --build opencode

compose-warm-up:
	CLI_RUNNER_IMAGE=$(IMAGE) \
	CODEX_WORKSPACE="$(WORKSPACE)" CODEX_CREDS="$(CREDS)" \
	GEMINI_WORKSPACE="$(WORKSPACE)" GEMINI_CREDS="$(CREDS)" \
	OPENCODE_WORKSPACE="$(WORKSPACE)" OPENCODE_CREDS="$(CREDS)" \
		$(COMPOSE) up -d --build warm-codex warm-gemini warm-opencode

compose-warm-down:
	$(COMPOSE) rm -sf warm-codex warm-gemini warm-opencode || true

# Resource profiles
compose-up-light:
	CODEX_CPUS=0.5 CODEX_MEM=1g GEMINI_CPUS=0.5 GEMINI_MEM=1g OPENCODE_CPUS=0.5 OPENCODE_MEM=1g \
		$(MAKE) compose-up IMAGE=$(IMAGE) WORKSPACE=$(WORKSPACE) CREDS=$(CREDS)

compose-up-standard:
	CODEX_CPUS=1.0 CODEX_MEM=2g GEMINI_CPUS=1.0 GEMINI_MEM=2g OPENCODE_CPUS=1.0 OPENCODE_MEM=2g \
		$(MAKE) compose-up IMAGE=$(IMAGE) WORKSPACE=$(WORKSPACE) CREDS=$(CREDS)

compose-up-heavy:
	CODEX_CPUS=2.0 CODEX_MEM=4g GEMINI_CPUS=2.0 GEMINI_MEM=4g OPENCODE_CPUS=2.0 OPENCODE_MEM=4g \
		$(MAKE) compose-up IMAGE=$(IMAGE) WORKSPACE=$(WORKSPACE) CREDS=$(CREDS)

compose-warm-up-light:
	CODEX_CPUS=0.5 CODEX_MEM=1g GEMINI_CPUS=0.5 GEMINI_MEM=1g OPENCODE_CPUS=0.5 OPENCODE_MEM=1g \
		$(MAKE) compose-warm-up IMAGE=$(IMAGE) WORKSPACE=$(WORKSPACE) CREDS=$(CREDS)

compose-warm-up-standard:
	CODEX_CPUS=1.0 CODEX_MEM=2g GEMINI_CPUS=1.0 GEMINI_MEM=2g OPENCODE_CPUS=1.0 OPENCODE_MEM=2g \
		$(MAKE) compose-warm-up IMAGE=$(IMAGE) WORKSPACE=$(WORKSPACE) CREDS=$(CREDS)

compose-warm-up-heavy:
	CODEX_CPUS=2.0 CODEX_MEM=4g GEMINI_CPUS=2.0 GEMINI_MEM=4g OPENCODE_CPUS=2.0 OPENCODE_MEM=4g \
		$(MAKE) compose-warm-up IMAGE=$(IMAGE) WORKSPACE=$(WORKSPACE) CREDS=$(CREDS)

spawner-install:
	cd spawner && npm install

spawner-start:
	cd spawner && CLI_RUNNER_IMAGE=$(IMAGE) npm start

spawner-dev:
	cd spawner && CLI_RUNNER_IMAGE=$(IMAGE) npm run dev
