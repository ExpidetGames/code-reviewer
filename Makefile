# Entry points for developers and agents. Every target is a thin wrapper around the commands
# of app/package.json and runner/pyproject.toml; see TESTING.md for what each level means.

APP := pnpm --dir app
RUNNER := uv --directory runner

.PHONY: help install lint lint-app lint-runner typecheck typecheck-app typecheck-runner \
	test-unit test-unit-app test-unit-runner test-integration test-e2e test-images verify

help:
	@echo "make install           install app and runner dependencies from the lockfiles"
	@echo "make lint              lint and format check, both parts"
	@echo "make typecheck         typecheck both parts"
	@echo "make test-unit         unit tests of both parts"
	@echo "make test-integration  integration tests that run on the host (app and runner)"
	@echo "make test-e2e          Playwright journeys against a production build (ARGS=... to filter)"
	@echo "make test-images       build both container images and run their smoke tests (needs Docker)"
	@echo "make verify            lint, typecheck, unit and host integration tests; run before every PR"

install:
	$(APP) install --frozen-lockfile
	$(RUNNER) sync --locked

lint: lint-app lint-runner
lint-app:
	$(APP) lint
	$(APP) format:check
lint-runner:
	$(RUNNER) run ruff check .
	$(RUNNER) run ruff format --check .

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

# Needs a browser. Without a downloaded Chromium, use an installed Chrome:
#   make test-e2e PLAYWRIGHT_CHANNEL=chrome
test-e2e:
	PLAYWRIGHT_CHANNEL=$(PLAYWRIGHT_CHANNEL) $(APP) test:e2e $(ARGS)

# Builds both container images and runs docker/smoke/app.sh and docker/smoke/runner.sh against them.
# Needs a running Docker daemon and fails without one. Not part of `make verify` (CI runs it for
# pull requests that touch the images).
test-images:
	docker build --tag code-reviewer-app:local app
	docker build --tag code-reviewer-runner:local runner
	docker/smoke/app.sh code-reviewer-app:local
	docker/smoke/runner.sh code-reviewer-runner:local

verify: lint typecheck test-unit test-integration
