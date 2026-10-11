# SPDX-License-Identifier: Apache-2.0

"""The platforms a job may come from, and what each one means for PR-Agent.

One table maps `git.provider` of a job to the PR-Agent settings that platform needs. The MVP has
one entry, `github`; a new platform is a new entry here plus its own tests, and nothing else in the
runner names GitHub's settings. A provider that is not in the table is refused as an invalid job
before any process is started.
"""

from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Platform:
    """The PR-Agent settings of one platform."""

    name: str
    # `config.git_provider` of PR-Agent (environment variable CONFIG__GIT_PROVIDER).
    git_provider: str
    # How PR-Agent authenticates: "user" works with a plain token, which is what an installation
    # token is (the identity patch supplies the login that "user" mode would ask the platform for).
    deployment_type_variable: str
    deployment_type: str
    # The environment variable that holds the API base URL of the platform.
    base_url_variable: str
    # The typed setting that holds the token (never an environment variable).
    token_setting: str


PLATFORMS: Mapping[str, Platform] = {
    "github": Platform(
        name="github",
        git_provider="github",
        deployment_type_variable="GITHUB__DEPLOYMENT_TYPE",
        deployment_type="user",
        base_url_variable="GITHUB__BASE_URL",
        token_setting="github.user_token",
    )
}


def platform_for(provider: str) -> Platform | None:
    """The mapping of a `git.provider`, or None if the platform is not supported."""
    return PLATFORMS.get(provider)
