"""Pins down that the question of an `ask` job never makes PR-Agent download an image.

PR-Agent's `/ask` takes the first markdown image or the first link that ends in an image extension
from the question and sends a HEAD request to it from the runner (redirects followed), then posts a
failure back with the address. The app removes such links before a job exists; the runner removes
them again from what it receives, so a job from another source or a gap in the app's rules still
cannot reach an address of the sender's choice. Both sides must give the results in the shared
fixture `fakes/fixtures/ask-question-images.json`."""

import json
from pathlib import Path
from typing import Any

import pytest
from pr_agent.tools.pr_questions import PRQuestions

from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.pr_agent_config import build_request
from code_reviewer_runner.question_images import IMAGE_LINK_PLACEHOLDER, remove_image_links

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "fakes/fixtures/ask-question-images.json").read_text()
)


def make_job(question: str) -> Job:
    job: dict[str, Any] = {
        "prUrl": "https://github.com/octo/repo/pull/7",
        "command": "ask",
        "args": [question],
        "git": {
            "provider": "github",
            "baseUrl": "https://api.github.com",
            "token": "dummy-installation-token-0123456789",
            "botLogin": "code-reviewer[bot]",
        },
        "llm": {
            "provider": "openrouter",
            "model": "deepseek/deepseek-chat",
            "apiKey": "dummy-openrouter-key-0123456789",
        },
    }
    return parse_job(json.dumps(job))


def pr_agent_image_of(question: str) -> str:
    """What PR-Agent's own `identify_image_in_comment` would download for this question."""
    instance = object.__new__(PRQuestions)
    instance.question_str = question
    instance.vars = {}
    return instance.identify_image_in_comment()  # pyright: ignore[reportUnknownVariableType]


def test_the_placeholder_is_the_one_the_app_uses() -> None:
    assert FIXTURE["placeholder"] == IMAGE_LINK_PLACEHOLDER


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["name"])
def test_a_question_gives_the_same_result_as_on_the_app_side(case: dict[str, str]) -> None:
    assert remove_image_links(case["input"]) == case["expected"]


@pytest.mark.parametrize(
    "question",
    [
        "see ![image](https://evil.test/a.png) why",
        "![image](http://169.254.169.254/latest/meta-data/)",
        "what is https://internal.test/a.png ?",
        "https://x.test/A.PNG",
        "https://x.test/a.png?token=1",
        "https://x.test/a.gif#top",
        "https://x.test/a.png;v=1",
        "https://user:pw@internal.test/a.webp",
        "!!![image](https://a.test/x.png)",
        "!https://a.test/x.png",
        "![![image](a)](https://a.test/x.png)",
        # Characters that other text engines count as white space but PR-Agent's pattern does not:
        # to PR-Agent the link goes on, so only a check with its own engine sees it.
        "https://a.test/x" + chr(0xFEFF) + ".png",
        "https://a.test/x" + chr(0x180E) + ".png https://b.test/y.png",
        "![image]\n(https://a.test/x.png)",
    ],
)
def test_nothing_in_a_cleaned_question_is_an_image_for_pr_agent(question: str) -> None:
    assert pr_agent_image_of(question) != "", "the example must be one PR-Agent would fetch"
    assert pr_agent_image_of(remove_image_links(question)) == ""


@pytest.mark.parametrize(
    "question",
    [
        "https://x.test/redirect?to=https://169.254.169.254/x.png",
        "ht![x](y)tps://a.test/x.png",
        "https://a.test/x.pn![x](y)g",
    ],
)
def test_text_that_only_becomes_a_link_once_a_part_is_cut_out_is_no_image_either(
    question: str,
) -> None:
    assert pr_agent_image_of(remove_image_links(question)) == ""


def test_a_job_never_hands_pr_agent_a_question_with_an_image() -> None:
    job = make_job("what is ![image](https://evil.test/a.png) and https://evil.test/b.JPG ?")

    request = build_request(job)

    assert pr_agent_image_of(job.args[0]) == ""
    assert job.args == ("what is [image link removed] and [image link removed] ?",)
    assert request[0] == "ask"
    assert len(request) == 2


def test_a_question_without_images_is_left_alone() -> None:
    question = "Why was the cache removed? See https://example.com/docs/page.\nThanks!"

    assert make_job(question).args == (question,)
