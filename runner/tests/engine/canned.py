# SPDX-License-Identifier: LicenseRef-Proprietary

"""Canned model answers that satisfy the output contract of each PR-Agent tool.

They carry a marker text so a test can tell one answer from another (the second review of a pull
request must show new text), and nothing about them is a judgement of the diff: the engine suite
checks the shape and the place of what is posted, never the quality of a review.
"""


def review(marker: str = "first run") -> str:
    return f"""```yaml
review:
  estimated_effort_to_review_[1-5]: 2
  relevant_tests: |
    No
  key_issues_to_review:
    - relevant_file: |
        greeting.py
      issue_header: |
        Missing input check ({marker})
      issue_content: |
        The helper formats the name without checking it ({marker}).
      start_line: 2
      end_line: 2
  security_concerns: |
    No
```
"""


def review_with_findings(tag: str, count: int, characters: int) -> str:
    """A review with `count` distinct findings of about `characters` each. Findings of another `tag`
    are new findings for PR-Agent, so the record of findings grows from run to run."""
    issues = ""
    for index in range(count):
        text = (f"Finding {tag}-{index} " + "word " * (characters // 5))[:characters]
        issues += f"""    - relevant_file: |
        greeting.py
      issue_header: |
        Issue {tag}-{index}
      issue_content: |
        {text}
      start_line: 2
      end_line: 2
"""
    return f"""```yaml
review:
  estimated_effort_to_review_[1-5]: 2
  relevant_tests: |
    No
  key_issues_to_review:
{issues}  security_concerns: |
    No
```
"""
