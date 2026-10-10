"""Keeps secrets out of the runner's own log lines.

The loop never logs a job's input, a lease token or a header on purpose. This is the second line:
every message passes through `SecretMasker`, which knows the runner token, the lease token and the
credentials of each running job, and also masks anything shaped like a credential.
"""

import logging
from collections.abc import Iterable

from code_reviewer_runner.redaction import Redactor


class SecretMasker:
    def __init__(self, fixed: Iterable[str] = ()) -> None:
        self._fixed = Redactor(fixed)
        self._by_job: dict[str, Redactor] = {}

    def add(self, key: str, secrets: Iterable[str]) -> None:
        self._by_job[key] = Redactor(secrets)

    def discard(self, key: str) -> None:
        self._by_job.pop(key, None)

    def redact(self, text: str) -> str:
        text = self._fixed.redact(text)
        for redactor in list(self._by_job.values()):
            text = redactor.redact(text)
        return text


class SafeLog:
    """A logger that masks every message. Messages are formatted before they are masked."""

    def __init__(self, logger: logging.Logger, masker: SecretMasker) -> None:
        self._logger = logger
        self._masker = masker

    def _log(self, level: int, message: str, args: tuple[object, ...]) -> None:
        if not self._logger.isEnabledFor(level):
            return
        text = message % args if args else message
        self._logger.log(level, "%s", self._masker.redact(text))

    def info(self, message: str, *args: object) -> None:
        self._log(logging.INFO, message, args)

    def warning(self, message: str, *args: object) -> None:
        self._log(logging.WARNING, message, args)

    def error(self, message: str, *args: object) -> None:
        self._log(logging.ERROR, message, args)
