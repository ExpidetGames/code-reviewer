// Canned model answers that satisfy the output contract of each PR-Agent tool (the same answers as
// runner/tests/engine/canned.py). They carry a marker text so a test can tell one answer from
// another (the second review of a pull request must show new text), and nothing about them is a
// judgement of the diff: the tests check the shape and the place of what is posted, never the
// quality of a review.

export function review(marker = "first run"): string {
  return `\`\`\`yaml
review:
  estimated_effort_to_review_[1-5]: 2
  relevant_tests: |
    No
  key_issues_to_review:
    - relevant_file: |
        greeting.py
      issue_header: |
        Missing input check (${marker})
      issue_content: |
        The helper formats the name without checking it (${marker}).
      start_line: 2
      end_line: 2
  security_concerns: |
    No
\`\`\`
`;
}

export function improve(marker = "first run"): string {
  return `\`\`\`yaml
code_suggestions:
- relevant_file: |
    greeting.py
  language: |
    python
  existing_code: |
    return f"Hello, {name}!"
  suggestion_content: |
    Strip the name before it is used (${marker}).
  improved_code: |
    return f"Hello, {name.strip()}!"
  one_sentence_summary: |
    Strip the name before greeting (${marker})
  label: |
    enhancement
\`\`\`
`;
}

export function reflect(): string {
  return `\`\`\`yaml
code_suggestions:
- suggestion_summary: |
    Strip the name before greeting
  relevant_file: |
    greeting.py
  relevant_lines_start: 2
  relevant_lines_end: 2
  suggestion_score: 8
  why: |
    A small and safe improvement.
\`\`\`
`;
}

export function describe(marker = "first run"): string {
  return `\`\`\`yaml
type:
- Enhancement
description: |
  Adds a greeting helper and a farewell helper (${marker}).
title: |
  Add greeting and farewell helpers
pr_files:
- filename: |
    greeting.py
  changes_summary: |
    Greets and says goodbye by name.
  changes_title: |
    Add helpers
  label: |
    enhancement
\`\`\`
`;
}

export function ask(marker = "first run"): string {
  return `The helper builds a greeting from a name (${marker}).`;
}

/** The kinds of prompt the fake tells apart, one per PR-Agent tool. */
export type PromptKind = "review" | "improve" | "reflect" | "describe" | "ask";

export function defaultReplies(): Record<PromptKind, string> {
  return {
    review: review(),
    improve: improve(),
    reflect: reflect(),
    describe: describe(),
    ask: ask(),
  };
}
