"""Pins down where PR-Agent 0.47.0 reads a repository's `.pr_agent.toml` from, as the runner
configures it: the default branch of the repository, through the contents API without a ref. Not
from the head of the pull request, so the author of a pull request cannot change how the review is
configured by changing the file in that pull request; a change takes effect once it is merged into
the default branch. The organization-wide settings repository is not read at all.

The runner README states this; if one of these tests fails after a PR-Agent upgrade, the statement
in the README has to be reviewed with it."""

from typing import Any

from support import current, make_job, pr_agent_module, request_scope

from code_reviewer_runner.pr_agent_runtime import configure_settings
from code_reviewer_runner.repo_settings_guard import RepoSettingsGuard

DEFAULT_BRANCH_FILE = b'[pr_reviewer]\nextra_instructions = "from the default branch"\n'


class FakeContent:
    def __init__(self, content: bytes) -> None:
        self.decoded_content = content


class FakeRepository:
    """Records every file read; knows a different file on the head branch of a pull request."""

    default_branch = "main"

    def __init__(self) -> None:
        self.reads: list[tuple[str, str | None]] = []

    def get_contents(self, path: str, ref: str | None = None) -> FakeContent:
        self.reads.append((path, ref))
        if ref == "pr-head":
            return FakeContent(b'[pr_reviewer]\nextra_instructions = "from the pull request"\n')
        return FakeContent(DEFAULT_BRANCH_FILE)


class UntouchedClient:
    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"the GitHub client must not be used (asked for {name})")


def file_content(result: Any) -> bytes:
    """`get_repo_settings` answers bytes, or a list of (scope, bytes) when scopes are involved."""
    if isinstance(result, bytes):
        return result
    return b"".join(content for _, content in result)


def provider_with(repository: FakeRepository) -> Any:
    github_provider = pr_agent_module("pr_agent.git_providers.github_provider").GithubProvider
    provider: Any = object.__new__(github_provider)
    provider.repo_obj = repository
    provider.github_client = UntouchedClient()
    provider._resolved_config_branch = None
    return provider


def test_the_repository_settings_come_from_the_default_branch_and_not_from_the_pull_request() -> (
    None
):
    repository = FakeRepository()

    with request_scope() as settings:
        configure_settings(make_job(), settings, RepoSettingsGuard())

        content = provider_with(repository).get_repo_settings()

    assert file_content(content) == DEFAULT_BRANCH_FILE
    assert repository.reads == [(".pr_agent.toml", None)]


def test_the_settings_repository_of_the_organization_is_not_read() -> None:
    with request_scope() as settings:
        configure_settings(make_job(), settings, RepoSettingsGuard())

        # UntouchedClient raises if the provider asks GitHub for `<owner>/pr-agent-settings`.
        provider_with(FakeRepository()).get_repo_settings()

        assert current().get("config.use_global_settings_file") is False


def test_negative_control_a_configured_branch_would_be_read_instead() -> None:
    # PR-Agent reads the branch from `config.config_branch`; the runner pins it to "".
    repository = FakeRepository()

    with request_scope() as settings:
        configure_settings(make_job(), settings, RepoSettingsGuard())
        settings.set("config.config_branch", "pr-head")

        content = provider_with(repository).get_repo_settings()

    assert b"from the pull request" in file_content(content)
    assert repository.reads == [(".pr_agent.toml", "pr-head")]
