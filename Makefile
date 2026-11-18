# Short names for the Web, Desktop and VOS commands. The package.json scripts
# they call stay the source of truth; docs/development.md documents both.
.DEFAULT_GOAL := help
.PHONY: help build clean web desktop dev-web dev-desktop vos-dev vos-dev-down vos-dev-logs vos-dev-status vos-dev-build vos-dev-shell

PNPM ?= pnpm
ARGS ?=
VOS_DEV := docker/vos-dev/vos-dev.sh

help:
	@echo "make build           pnpm run build                      complete repository build"
	@echo "make clean           pnpm run clean                      remove build outputs and safe deleted-package residue"
	@echo "make web             pnpm run start:web                  serve the built Web artifacts from source"
	@echo "make desktop         pnpm run start:desktop              launch the built Desktop artifacts"
	@echo "make dev-web         pnpm run dev:web                    build, serve, and rebuild Web on source edits"
	@echo "make dev-desktop     pnpm run dev:desktop                build, then launch Desktop"
	@echo "make vos-dev         $(VOS_DEV) up      debug this source tree inside VOS"
	@echo "make vos-dev-down    $(VOS_DEV) down    stop it and remove its platform route"
	@echo "make vos-dev-status  $(VOS_DEV) status  container, health and route state"
	@echo "make vos-dev-logs    $(VOS_DEV) logs    follow the container log"
	@echo "make vos-dev-build   $(VOS_DEV) build   rebuild the Host artifact tree in it"
	@echo "make vos-dev-shell   $(VOS_DEV) shell   shell inside it"
	@echo "ARGS='--no-open --port 3081' forwards options to the launched application;"
	@echo "the Web commands accept dsh web flags, the Desktop launcher accepts none."

build:
	$(PNPM) run build

clean:
	$(PNPM) run clean

web:
	$(PNPM) run start:web $(ARGS)

desktop:
	$(PNPM) run start:desktop $(ARGS)

dev-web:
	$(PNPM) run dev:web $(ARGS)

dev-desktop:
	$(PNPM) run dev:desktop $(ARGS)

vos-dev:
	$(VOS_DEV) up

vos-dev-down:
	$(VOS_DEV) down

vos-dev-status:
	$(VOS_DEV) status

vos-dev-logs:
	$(VOS_DEV) logs

vos-dev-build:
	$(VOS_DEV) build

vos-dev-shell:
	$(VOS_DEV) shell
