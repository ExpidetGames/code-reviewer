# Entry points for developers and agents. Every target is a thin wrapper around the commands
# of app/package.json and runner/pyproject.toml; see TESTING.md for what each level means.

APP := pnpm --dir app
RUNNER := uv --directory runner

.PHONY: help install lint lint-app lint-runner typecheck typecheck-app typecheck-runner \
	test-unit test-unit-app test-unit-runner test-integration check-licenses fix-spdx-headers test-engine test-e2e test-images test-compose verify

help:
	@echo "make install           install app and runner dependencies from the lockfiles"
	@echo "make lint              lint and format check, both parts"
	@echo "make typecheck         typecheck both parts"
	@echo "make test-unit         unit tests of both parts"
	@echo "make test-integration  integration tests that run on the host (app and runner)"
	@echo "make check-licenses     fail when a dependency has a license outside license-policy.json (needs make install)"
	@echo "make fix-spdx-headers   add the SPDX license header to every source file that lacks it (a unit test fails without it)"
	@echo "make test-engine       the real PR-Agent against the fake GitHub and LLM (about 4 minutes, not part of verify)"
	@echo "make test-e2e          Playwright journeys against a production build (ARGS=... to filter)"
	@echo "make test-images       build both container images and run their smoke tests (needs Docker)"
	@echo "make test-compose      build both images and smoke test the Docker Compose stack (needs Docker)"
	@echo "make verify            lint, typecheck, unit and host integration tests and the license check; run before every PR"

install:
	$(APP) install --frozen-lockfile
	$(RUNNER) sync --locked

lint: lint-app lint-runner
lint-app:
	$(APP) lint
	$(APP) format:check
lint-runner:
	$(RUNNER) run ruff check . ../fakes
	$(RUNNER) run ruff format --check . ../fakes

typecheck: typecheck-app typecheck-runner
typecheck-app:
	$(APP) typecheck
typecheck-runner:
	$(RUNNER) run pyright

test-unit: test-unit-app test-unit-runner
test-unit-app:
	$(APP) test
test-unit-runner:
	$(RUNNER) run pytest -m unit

# Integration tests that need no Docker stack. The stack based suites (fakes, e2e in
# containers, engine smoke) are added with the tickets that introduce the stack.
test-integration:
	$(APP) test:int
	$(RUNNER) run pytest -m "integration or contract"

# The license of every installed dependency of the app and the runner against license-policy.json
# (app/src/ci/license-check). Reads installed metadata and both lockfiles, no network.
check-licenses:
	$(APP) licenses:check

# Adds `SPDX-License-Identifier: Apache-2.0` (in the comment syntax of the language) to every source file
# that lacks it; changes nothing else and can be run at any time. Which files count is in
# app/src/ci/spdx-headers/rules.ts.
fix-spdx-headers:
	$(APP) spdx:add

# The real PR-Agent through the job entry point against the fakes (runner/tests/engine). The first
# step needs the internet once (tiktoken encoding); the tests themselves never leave loopback.
test-engine:
	$(RUNNER) run python scripts/prime_tiktoken_cache.py
	$(RUNNER) run pytest -m engine

# Needs a browser. Without a downloaded Chromium, use an installed Chrome:
#   make test-e2e PLAYWRIGHT_CHANNEL=chrome
test-e2e:
	PLAYWRIGHT_CHANNEL=$(PLAYWRIGHT_CHANNEL) $(APP) test:e2e $(ARGS)

# Builds both container images and runs docker/smoke/app.sh and docker/smoke/runner.sh against them.
# Needs a running Docker daemon and fails without one. Not part of `make verify` (CI runs it for
# pull requests that touch the images).
test-images:
	docker build --file app/Dockerfile --tag code-reviewer-app:local .
	docker build --file runner/Dockerfile --tag code-reviewer-runner:local .
	docker/smoke/app.sh code-reviewer-app:local
	docker/smoke/runner.sh code-reviewer-runner:local

# Builds both images (under tags of their own, so images of other work stay untouched) and runs
# docker/smoke/compose.sh against them: the stack starts with dummy settings, the runner waits for a
# healthy app, the data survives down and up, a killed app restarts. Needs a running Docker daemon.
# Not part of `make verify`; CI runs it for pull requests that touch app, runner or the compose files.
test-compose:
	docker build --file app/Dockerfile --tag code-reviewer-app:compose .
	docker build --file runner/Dockerfile --tag code-reviewer-runner:compose .
	docker/smoke/compose.sh code-reviewer-app:compose code-reviewer-runner:compose

verify: lint typecheck test-unit test-integration check-licenses
