"""Removes markdown images and links to images from the question of an `ask` job.

PR-Agent's `/ask` takes the first markdown image (`![image]`) or the first link that ends in an
image extension out of the question and downloads it from the runner (a HEAD request, redirects
followed, and a failure is posted back with the address). Whoever may write a command could so make
the runner request an address of their choice. The app removes such links before a job exists; this
is the second line: whatever reaches the runner is cleaned again, with the text engine PR-Agent
itself reads the question with. The rules are wider than PR-Agent's on purpose and must give the
results in `fakes/fixtures/ask-question-images.json`, which the app's tests use too.
"""

import re

IMAGE_LINK_PLACEHOLDER = "[image link removed]"

# Any `![...]` with what follows it in brackets or parentheses.
_MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\](?:[ \t]*\([^)\n]*\)?|[ \t]*\[[^\]\n]*\])?")
# The pattern PR-Agent finds links with (`pr_questions.py`), plus case insensitivity.
_LINK = re.compile(r"https?://[^\s'\"<>)\]]+", re.IGNORECASE)
# A link with an image extension anywhere in it (path, query or fragment) is removed.
_IMAGE_EXTENSION = re.compile(
    r"\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)(?![a-z0-9])", re.IGNORECASE
)

_MAX_ROUNDS = 5


def _replace_link(match: re.Match[str]) -> str:
    link = match.group(0)
    return IMAGE_LINK_PLACEHOLDER if _IMAGE_EXTENSION.search(link) else link


def remove_image_links(text: str) -> str:
    """The text with markdown images and links to images replaced by the placeholder.

    Removing one can bring the rest of another together, so it repeats until nothing changes."""
    current = text
    for _ in range(_MAX_ROUNDS):
        following = _LINK.sub(_replace_link, _MARKDOWN_IMAGE.sub(IMAGE_LINK_PLACEHOLDER, current))
        if following == current:
            return following
        current = following
    return current
