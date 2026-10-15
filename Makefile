# SPDX-License-Identifier: Apache-2.0

# Entry points for developers and agents. Every target is a thin wrapper around the commands
# of app/package.json, dispatcher/package.json and runner/pyproject.toml; see TESTING.md for what each
# level means.

APP := pnpm --dir app
DISPATCHER := pnpm --dir dispatcher
RUNNER := uv --directory runner

.PHONY: help install lint lint-app lint-dispatcher lint-runner typecheck typecheck-app typecheck-dispatcher typecheck-runner \
	test-unit test-unit-app test-unit-dispatcher test-unit-runner test-integration check-licenses fix-spdx-headers generate-contracts check-contracts test-engine test-e2e test-e2e-dynamic test-images test-compose verify

help:
	@echo "make install           install app, dispatcher and runner dependencies from the lockfiles"
	@echo "make lint              lint and format check, all three parts"
	@echo "make typecheck         typecheck all three parts"
	@echo "make test-unit         unit tests of all three parts"
	@echo "make test-integration  integration tests that run on the host (app, dispatcher and runner)"
	@echo "make check-licenses    fail when a dependency has a license outside license-policy.json (needs make install)"
	@echo "make generate-contracts regenerate the TypeScript types of contracts/*.v1.json (app/src/contracts, dispatcher/src/contracts)"
	@echo "make check-contracts   fail when the generated contract types differ from the schemas (part of verify)"
	@echo "make fix-spdx-headers  add the SPDX license header to every source file that lacks it (a unit test fails without it)"
	@echo "make test-engine       the real PR-Agent and the pinned OpenCode against the fakes (about 5 minutes, not part of verify)"
	@echo "make test-e2e          Playwright journeys against a production build (ARGS=... to filter)"
	@echo "make test-e2e-dynamic   the privileged Dynamic Review journey with the real OpenCode (root and nft, CI-first, ARGS=... to filter)"
	@echo "make test-images       build the container images (the Dynamic runner and Sandbox targets too) and run their smoke tests (needs Docker)"
	@echo "make test-compose      build both images and smoke test the Docker Compose stack (needs Docker)"
	@echo "make verify            lint, typecheck, unit and host integration tests and the license check; run before every PR"

install:
	$(APP) install --frozen-lockfile
	$(DISPATCHER) install --frozen-lockfile
	$(RUNNER) sync --locked

lint: lint-app lint-dispatcher lint-runner
lint-app:
	$(APP) lint
	$(APP) format:check
lint-dispatcher:
	$(DISPATCHER) lint
	$(DISPATCHER) format:check
lint-runner:
	$(RUNNER) run ruff check . ../fakes
	$(RUNNER) run ruff format --check . ../fakes

typecheck: typecheck-app typecheck-dispatcher typecheck-runner
typecheck-app:
	$(APP) typecheck
typecheck-dispatcher:
	$(DISPATCHER) typecheck
typecheck-runner:
	$(RUNNER) run pyright

test-unit: test-unit-app test-unit-dispatcher test-unit-runner
test-unit-app:
	$(APP) test
test-unit-dispatcher:
	$(DISPATCHER) test
test-unit-runner:
	$(RUNNER) run pytest -m unit

# Integration tests that need no Docker stack. The stack based suites (fakes, e2e in
# containers, engine smoke) are added with the tickets that introduce the stack.
test-integration:
	$(APP) test:int
	$(DISPATCHER) test:int
	$(RUNNER) run pytest -m "integration or contract"

# The license of every installed dependency of the app, the Dispatcher and the runner against license-policy.json
# (app/src/ci/license-check). Reads installed metadata and the lockfiles of app, dispatcher and runner, no network.
check-licenses:
	$(APP) licenses:check

# The TypeScript types of the contract schemas (#318), committed into app/src/contracts and
# dispatcher/src/contracts so no project imports another's source. `check-contracts` fails with the
# command to regenerate when a committed file is stale; it reads the schemas only, no network.
generate-contracts:
	$(APP) contracts:generate

check-contracts:
	$(APP) contracts:check

# Adds `SPDX-License-Identifier: Apache-2.0` (in the comment syntax of the language) to every source file
# that lacks it; changes nothing else and can be run at any time. Which files count is in
# app/src/ci/spdx-headers/rules.ts.
fix-spdx-headers:
	$(APP) spdx:add

# The real PR-Agent and the real pinned OpenCode against the fakes (runner/tests/engine). The first
# steps need the internet once (tiktoken encoding, the checksum-verified OpenCode release) and the
# OpenCode suite needs a ripgrep on the PATH; the tests themselves never leave loopback.
test-engine:
	$(RUNNER) run python scripts/prime_tiktoken_cache.py
	$(RUNNER) run python scripts/fetch_opencode.py
	$(RUNNER) run pytest -m engine

# Needs a browser. Without a downloaded Chromium, use an installed Chrome:
#   make test-e2e PLAYWRIGHT_CHANNEL=chrome
test-e2e:
	PLAYWRIGHT_CHANNEL=$(PLAYWRIGHT_CHANNEL) $(APP) test:e2e $(ARGS)

# The privileged Dynamic Review lane (#253): needs sudo, nft and the internet once (the pinned OpenCode
# and ripgrep). It fails, with the missing item named, where it cannot run; it never skips.
test-e2e-dynamic:
	cd runner && scripts/run_dynamic_e2e.sh $(ARGS)

# Builds both container images and runs docker/smoke/app.sh and docker/smoke/runner.sh against them.
# Needs a running Docker daemon and fails without one. Not part of `make verify` (CI runs it for
# pull requests that touch the images).
test-images:
	docker build --file app/Dockerfile --tag code-reviewer-app:local .
	docker build --file runner/Dockerfile --tag code-reviewer-runner:local .
	docker build --file runner/Dockerfile --target dynamic --tag code-reviewer-runner-dynamic:local .
	docker build --file runner/Dockerfile --target sandbox --tag code-reviewer-runner-sandbox:local .
	docker/smoke/app.sh code-reviewer-app:local
	docker/smoke/upgrade.sh code-reviewer-app:local
	docker/smoke/runner.sh code-reviewer-runner:local
	docker/smoke/runner.sh code-reviewer-runner-dynamic:local dynamic
	docker/smoke/runner.sh code-reviewer-runner-sandbox:local sandbox code-reviewer-runner-dynamic:local

# Builds both images (under tags of their own, so images of other work stay untouched) and runs
# docker/smoke/compose.sh against them: the stack starts with dummy settings, the runner waits for a
# healthy app, the data survives down and up, a killed app restarts. Needs a running Docker daemon.
# Not part of `make verify`; CI runs it for pull requests that touch app, runner or the compose files.
test-compose:
	docker build --file app/Dockerfile --tag code-reviewer-app:compose .
	docker build --file runner/Dockerfile --tag code-reviewer-runner:compose .
	docker/smoke/compose.sh code-reviewer-app:compose code-reviewer-runner:compose

verify: lint typecheck check-contracts test-unit test-integration check-licenses
