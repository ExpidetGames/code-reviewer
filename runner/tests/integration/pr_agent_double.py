"""Test helper, not a test: runs the real runner entry point with PR-Agent's `handle_request`
replaced by a double, so a test can start the runner as a real process without any network.

    python pr_agent_double.py <scenario> <report-file>   (the job JSON is read from stdin)

The double is installed from inside the runner (right after the environment is built and before
PR-Agent is used), because PR-Agent reads its settings from the environment when it is first
imported and the test must see the production configuration. What the double observed is written to
the report file as JSON; the scenario decides what the double does:

    publish    post a review comment through the real GitHub provider class (recorder, patch)
    raise      raise an exception whose text contains both secrets
    leak       write both secrets to stdout, stderr, loguru and the standard logging module
    failure    post a "Failed to review PR" comment and return True
    chatty     print to stdout (must not end up on the result channel)
"""

import json
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from code_reviewer_runner import runner

SCENARIO = sys.argv[1]
REPORT = Path(sys.argv[2])
# From here on the runner must see the argv of the installed console script, nothing more.
ARGV_SEEN_BY_RUNNER = list(sys.argv)
sys.argv = ["code-reviewer-run-job"]


def stub_provider() -> Any:
    from pr_agent.git_providers.github_provider import GithubProvider

    class Pull:
        def create_issue_comment(self, body: str) -> Any:
            return type("Comment", (), {"html_url": "https://github.com/octo/repo/pull/7#c1"})()

    provider: Any = object.__new__(GithubProvider)
    provider.pr = Pull()
    provider.issue_main = None
    provider.max_comment_chars = 65000
    return provider


def install_double() -> None:
    from loguru import logger
    from pr_agent.agent.pr_agent import PRAgent
    from pr_agent.config_loader import get_settings as untyped_get_settings

    get_settings: Any = untyped_get_settings  # Any: PR-Agent ships no type information

    async def handle_request(
        self: Any, pr_url: str, request: Any, notify: Any = None, propagate_tool_errors: Any = None
    ) -> bool:
        token = os.environ["GITHUB__USER_TOKEN"]
        key = os.environ["OPENROUTER__KEY"]
        report: dict[str, Any] = {
            "calls": 1,
            "pr_url": pr_url,
            "request": request,
            "propagate_tool_errors": propagate_tool_errors,
            "deployment_type": get_settings().github.deployment_type,
            "git_provider": get_settings().config.git_provider,
            "model": get_settings().config.model,
            "fallback_models": get_settings().config.fallback_models,
            "token_in_settings": get_settings().github.user_token == token,
            "environ_names": sorted(os.environ),
            "argv": ARGV_SEEN_BY_RUNNER,
            "cwd_files": sorted(p.name for p in Path.cwd().iterdir()),
            "login": stub_provider()._resolve_user_login(),
        }
        REPORT.write_text(json.dumps(report))
        if SCENARIO == "publish":
            stub_provider().publish_comment(
                "## PR Reviewer Guide 🔍\n\n<!-- pr-agent:review:full -->\n\nx"
            )
            return True
        if SCENARIO == "failure":
            stub_provider().publish_comment("Failed to review PR: boom")
            return True
        if SCENARIO == "chatty":
            print("hello from a library on stdout")
            return True
        if SCENARIO == "leak":
            for secret in (token, key):
                print(f"stdout {secret}")
                sys.stderr.write(f"stderr {secret}\n")
                logger.info(f"loguru {secret}")
                logging.getLogger("leaky").warning("stdlib %s", secret)
            return True
        if SCENARIO == "raise":
            raise RuntimeError(f"upstream said no to {token} and {key}")
        raise AssertionError(f"unknown scenario {SCENARIO}")

    PRAgent.handle_request = handle_request  # type: ignore[method-assign]
    REPORT.with_suffix(".tmp-listing").write_text(
        json.dumps(sorted(os.listdir(tempfile.gettempdir())))
    )


_real_check = runner.check_pr_agent_version


def check_then_install(*args: Any, **kwargs: Any) -> None:
    _real_check(*args, **kwargs)
    install_double()


runner.check_pr_agent_version = check_then_install

if __name__ == "__main__":
    sys.exit(runner.main([]))
