// SPDX-License-Identifier: LicenseRef-Proprietary

// Canned model answers that satisfy the output contract of the review tool (the same answer as
// runner/tests/engine/canned.py). It carries a marker text so a test can tell one answer from
// another (the second review of a pull request must show new text), and nothing about it is a
// judgement of the diff: the tests check the shape and the place of what is posted, never the
// quality of a review. `/ask`, `/improve` and `/describe` were removed (#203).

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

/** The kinds of prompt the fake tells apart; `/review` is the only tool (#203). */
export type PromptKind = "review";

export function defaultReplies(): Record<PromptKind, string> {
  return { review: review() };
}
