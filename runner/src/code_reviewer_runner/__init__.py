"""Code Reviewer runner: picks up review jobs from the app and runs PR-Agent."""

from importlib.metadata import PackageNotFoundError, version

_UNKNOWN_VERSION = "0+unknown"


def resolve_version() -> str:
    """Return the installed package version, or a placeholder when run from source."""
    try:
        return version("code-reviewer-runner")
    except PackageNotFoundError:
        return _UNKNOWN_VERSION


__version__ = resolve_version()
# tmp
