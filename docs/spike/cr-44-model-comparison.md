# CR-44 spike: choosing the default review model (at most 0.10 USD per review)

Date: 2026-10-10. PR-Agent `pr-agent==0.47.0` through the runner entry point (`code-reviewer-run-job`),
command `review`, installation token, models through OpenRouter. Everything below was measured with
`runner/scripts/manual_review.py` (extended in this ticket with `--record-dir` and `--label`, see
"Method"). The customer limit is at most 0.10 USD per review on average.

> Note (2026-10-11): CR-50 supersedes the hit rates of CR-44 and CR-48 (shared comment state, see "Comparison with CR-44 and CR-48" in [`cr-50-fair-model-comparison.md`](cr-50-fair-model-comparison.md)); their cost data stays valid.

## Decision

Decided by the project lead on 2026-10-10 on the basis of this report: the default review model is
**`anthropic/claude-haiku-5.5`**, **`anthropic/claude-sonnet-5.5`** is the per-project alternative (with the
CR-25 warning above 0.10 USD estimated), and **`openai/gpt-5.4-mini`** is the second alternative. Re-measure when
PR-Agent, the prompts or the model list change.

## Result in short

- **Default: `anthropic/claude-haiku-5.5`.** Average 0.0027 USD per review (largest 0.0052 USD),
  about 23 s per review, no failed run, no false positive. It found both planted problems of the small
  and of the large pull request in every run and, on the hard medium pull request, 9 of 15 planted
  problems in five runs. It is about 6 times cheaper than GPT-5.4 mini, 2.4 times cheaper than the DeepSeek reference
  and 18 times cheaper than Sonnet.
- **Alternative 1 (best quality, highest cost): `anthropic/claude-sonnet-5.5`.** Found the most planted
  problems (13 of 14 in the two required runs, 13 of 15 on the medium pull request in five runs), average
  0.049 USD per review, **but 0.1004 USD for the large pull request** (about 0.12 USD when the estimate uses
  the Claude tokenizer factor), i.e. over the limit for a single large review, although the average over the
  three sizes is half of the limit. Good as a per-project override for important repositories, where the warning
  of CR-25 (above 0.10 USD estimated) applies.
- **Alternative 2 (other vendor): `openai/gpt-5.4-mini`.** Average 0.015 USD, 34 s, no failure, no false
  positive, finds the problems of the small and large pull request but only 6 of 15 on the medium one.
- **Not recommended:** `google/gemini-3.8-flash` (finds the fewest planted problems, 1 of 15 on the medium pull
  request, and is expensive for its quality because it spends 2k to 14k output tokens per review) and
  `deepseek/deepseek-v3.2` (cheap, but slowest at 96 s on average, 1 of 6 required runs failed with
  `llm_output_invalid`, and 4 of 15 on the medium pull request).
- Honest caveats: two runs per pull request (five on the medium one) are a small sample, and a model's
  findings change from run to run; one review of the large pull request already shows how much the tokenizer
  matters (the same 32k-token diff is 45k tokens for Claude, 41k for Gemini and 31k for DeepSeek and GPT).
  `anthropic/claude-haiku-5.5` was added as a fifth model after the first round (see "Method"), the ticket
  asked for 3 to 4 candidates; among the four original candidates the best is `anthropic/claude-sonnet-5.5`
  on quality and `openai/gpt-5.4-mini` on value.

Total spend of this ticket: about 0.98 USD (45 recorded reviews 0.961 USD, one pilot review 0.015 USD, one
aborted run of a few cents at most), far below the 4 USD budget.

## Method

- **Pull requests:** `ExpidetGames/code-reviewer-playground` #1 (small, 39 additions), #2 (medium, 472
  additions, 15 files), #3 (large, 3,858 additions, 69 files). The diff that reaches the model is 3.0k /
  7.7k / 31.5k tokens (CR-13, DeepSeek tokenizer); PR-Agent cuts the large one to its 32k limit, so the
  other models see 4.5k / 11.9k / 45.0k tokens (Claude), 3.3k / 8.8k / 41.0k (Gemini) or about 2.9k / 7.4k /
  30.5k (GPT), because they count tokens differently.
- **Settings, identical for every model:** the runner defaults (review labels off, no progress comment, no
  extra "updated" comment, fallback models off, all model roles pinned to the job model, repository file
  `AGENTS.md` as context), no `job.env` options, `llm.maxTokens` 163,840 for all. Only `llm.model` differs.
  The command is `review` and nothing else.
- **Runs:** every model reviewed each pull request twice (runs 1 and 2), sequentially for each pull request.
  The three pull requests ran in parallel streams (CR-13 measured no slowdown up to three parallel
  reviews); two reviews of the same pull request never ran at the same time, because a pull request has one
  review comment that every run edits in place. After a supplementary round, the medium pull request was
  reviewed three more times per model (runs 3 to 5) because it was the only pull request that told the
  models apart.
- **The reference model** `deepseek/deepseek-v3.2` was measured again with the same settings (CR-13 numbers
  agree: 0.002 to 0.011 USD, 41 to 200 s), so the table is consistent. Nothing was reused.
- **Recording:** `manual_review.py --yes --record-dir DIR --label NAME` writes the result JSON of the runner
  (with model, pull request and wall time) and the text of the review comment right after the run, because
  the next run overwrites the comment. Nothing is written if the installation token or the LLM key shows up
  in the output or in the comment. The raw records stay outside the repository; the appendix lists every run.
  The comment link of a run is the same for all runs of a pull request: #1
  `issuecomment-6097473386`, #2 `issuecomment-6098095542`, #3 `issuecomment-6098167593`.
- **Cost** is `usage.costUsd` of the result (PR-Agent, from the token counts and OpenRouter list prices;
  it matches the list price times the tokens). **Duration** is the runner's `durationMs`.
- **Evaluation** is manual against the list of planted problems (kept outside the repository, as agreed).
  A planted problem counts as found when the visible findings of that run name it (the hidden "resolved
  findings" and state block of the comment hold earlier runs and were ignored). A finding is a false
  positive when it points to no real problem; real problems that were not planted are counted neither as hit
  nor as false positive and are named below. The judgement is mine and was done carefully but by hand; two
  borderline calls are named in the notes.
- **Supplementary round:** `anthropic/claude-haiku-5.5` (cheap, new, from a vendor that is also a candidate
  with Sonnet) was added after the first round showed that quality and price are not related in a simple way.
  It got the same runs as the others. It is marked as supplementary in every table.

## Candidates and price calculation (CR-44-T01)

Selection: OpenRouter's public model list (`https://openrouter.ai/api/v1/models`, fetched 2026-10-10),
models with at least 64k context whose price for the assumed large review (32,000 input tokens and 3,000
output tokens) is below 0.10 USD, strong coding or general models of different vendors that are not tiny:
Anthropic, Google, OpenAI and the DeepSeek reference. Prices are USD per million tokens.

| Model id | Vendor | Input | Output | Estimate large review: 32k in + 3k out | Estimate with tokenizer factor | Measured, large PR (avg of 2) |
|---|---|---|---|---|---|---|
| `deepseek/deepseek-v3.2` (reference) | DeepSeek | 0.259 | 0.80 | 0.0083 + 0.0024 = **0.0107** | factor 1.0: 0.0107 | 0.0100 |
| `google/gemini-3.8-flash` | Google | 0.75 | 3.75 | 0.0240 + 0.0113 = **0.0353** | factor 1.3 (41.6k in): 0.0425 | 0.0472 |
| `openai/gpt-5.4-mini` | OpenAI | 0.75 | 4.50 | 0.0240 + 0.0135 = **0.0375** | factor 1.0: 0.0375 | 0.0186 |
| `anthropic/claude-sonnet-5.5` | Anthropic | 2.00 | 10.00 | 0.0640 + 0.0300 = **0.0940** | factor 1.4 (44.8k in): **0.1196, above 0.10** | 0.1003 |
| `anthropic/claude-haiku-5.5` (supplementary) | Anthropic | 0.10 | 0.50 | 0.0032 + 0.0015 = **0.0047** | factor 1.4 (44.8k in): 0.0060 | 0.0051 |

Formula: `32,000 x input price / 1,000,000 + 3,000 x output price / 1,000,000`. The estimate for the large pull
request is the one that matters for the limit, small and medium reviews cost less.

The plain estimate (32k in) is wrong for models whose tokenizer counts the same pruned diff higher: PR-Agent
cuts the large diff to 32k tokens by its own count, but Claude sees 44.8k to 45.0k tokens (factor 1.4) and
Gemini 41.0k (factor 1.3); DeepSeek and GPT-5.4 mini see about 30.5k to 31.5k (factor 1.0). With the factor
the large-pull-request estimate for **Sonnet is 0.1196 USD, above the limit**: T01 ("every candidate is below
10 cent for a large pull request") holds for the plain estimate but **not for Sonnet once the tokenizer is
taken into account**. The measured 0.1003 USD is only that low because Sonnet wrote about 1k output tokens
instead of the assumed 3k. Measured against the plain estimate (large pull request, average of two runs):
DeepSeek 0.0100 and GPT-5.4 mini 0.0186 are below it; **Haiku 0.0051 (estimate 0.0047) and Gemini 0.0472
(estimate 0.0353, plus 34 percent) are above it, and Sonnet 0.1003 (estimate 0.0940) as well**. Haiku and
Sonnet through the tokenizer, Gemini mainly through reasoning tokens, which are billed as output tokens and
which the estimate of 3k output tokens does not cover (Gemini used 2k to 14k output tokens). For CR-25's
estimator: use the factor per vendor, and warn above 0.10 USD for Sonnet.

Other models below the limit that were not tried (budget and time, not a judgement): for example
`moonshotai/kimi-k2.7-code` (0.0315), `qwen/qwen3-coder-next` (0.0062), `mistralai/devstral-2512` (0.0188),
`x-ai/grok-4.3` (0.0475), `z-ai/glm-5.1` (0.040).

## Results (CR-44-T02, T03, T04, T05)

Required runs: two per model and pull request (runs 1 and 2). "Planted found" counts planted problems
found in the runs, out of (problems x runs): small 2 x 2 = 4, medium 3 x 2 = 6, large 2 x 2 = 4.
Cost and duration are over the six runs of a model (so each size has the same weight; the real mix of pull
request sizes is not known).

| Model | Hit rate small (#1) | Hit rate medium (#2) | Hit rate large (#3) | Total | False positives | Failures | Cost avg / max (USD) | Duration avg / max (s) |
|---|---|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-5.5` | 4 of 4 | 5 of 6 | 4 of 4 | **13 of 14** | 1 | 0 | 0.0488 / **0.1004** | 23 / 34 |
| `anthropic/claude-haiku-5.5` (supplementary) | 4 of 4 | 3 of 6 | 4 of 4 | 11 of 14 | 0 | 0 | **0.0027** / 0.0052 | 23 / 32 |
| `openai/gpt-5.4-mini` | 4 of 4 | 2 of 6 | 4 of 4 | 10 of 14 | 0 | 0 | 0.0154 / 0.0259 | 34 / 54 |
| `deepseek/deepseek-v3.2` (reference) | 2 of 4 | 2 of 6 | 4 of 4 | 8 of 14 | 0 | 1 (`llm_output_invalid`) | 0.0066 / 0.0104 | 96 / 157 |
| `google/gemini-3.8-flash` | 2 of 4 | 0 of 6 | 4 of 4 | 6 of 14 | 0 | 0 | 0.0355 / 0.0610 | 51 / 98 |

Durations are over the successful runs (DeepSeek over all six runs: 90 s average). Cost per size (average of the two runs, USD):

| Model | Small (#1) | Medium (#2) | Large (#3) |
|---|---|---|---|
| `deepseek/deepseek-v3.2` | 0.0048 | 0.0049 | 0.0100 |
| `anthropic/claude-haiku-5.5` | 0.0009 | 0.0022 | 0.0051 |
| `openai/gpt-5.4-mini` | 0.0037 | 0.0240 | 0.0186 |
| `google/gemini-3.8-flash` | 0.0100 | 0.0492 | 0.0472 |
| `anthropic/claude-sonnet-5.5` | 0.0147 | 0.0313 | 0.1003 |

### Per planted problem type (CR-44-T03)

The planted problems are labeled neutrally on purpose (the repository is public, the playground pull requests
should stay a blind benchmark): **#1** A and B, **#2** A, B and C, **#3** A and B. The descriptions are kept in
the private notes. "Found" is runs with the problem named, out of the runs. The medium pull request is shown for
all five runs.

| Model | #1 A | #1 B | #2 A (5 runs) | #2 B (5 runs) | #2 C (5 runs) | #3 A | #3 B |
|---|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-5.5` | 2 of 2 | 2 of 2 | 4 of 5 | 5 of 5 | 4 of 5 | 2 of 2 | 2 of 2 |
| `anthropic/claude-haiku-5.5` | 2 of 2 | 2 of 2 | 4 of 5 | 1 of 5 | 4 of 5 | 2 of 2 | 2 of 2 |
| `openai/gpt-5.4-mini` | 2 of 2 | 2 of 2 | 4 of 5 | 2 of 5 | 0 of 5 | 2 of 2 | 2 of 2 |
| `deepseek/deepseek-v3.2` | 1 of 2 (1 run failed) | 1 of 2 (1 run failed) | 2 of 5 | 2 of 5 | 0 of 5 | 2 of 2 | 2 of 2 |
| `google/gemini-3.8-flash` | 2 of 2 | 0 of 2 | 0 of 5 | 0 of 5 | 1 of 5 | 2 of 2 | 2 of 2 |

Reading: #3 is found by every model every time; #1 by all but Gemini (never #1 B). The medium pull request
separates the models. Only Sonnet finds #2 B regularly (5 of 5); Haiku, the default, finds #2 A and #2 C
(4 of 5 each) but #2 B in only 1 of 5 runs, fewer than GPT-5.4 mini and DeepSeek (2 of 5 each). #2 A is found by
Sonnet, Haiku and GPT-5.4 mini in four of five runs. Hit rates over the five runs of the medium pull request
(of 15): Sonnet 13, Haiku 9, GPT-5.4 mini 6, DeepSeek 4, Gemini 1. A smaller secondary problem on #2 (D) was named
by Sonnet in all five runs, by Haiku in three, by DeepSeek in two and by none of the others (not counted in the
hit rates).

Notes on borderline calls (counted as found, each named in only one sentence of a finding about something else):
Sonnet medium run 2 and run 4 for #2 A, and Haiku medium run 5 for #2 B. Strict counting without these three
gives Sonnet 11 and Haiku 8 of 15; the ranking does not change.

### False positives (CR-44-T04)

One false positive in all 45 runs:

- `anthropic/claude-sonnet-5.5`, medium pull request, run 1: a remark on the stacking mode of the discount engine
  whose "undocumented" half is wrong, because the engine's own doc comment describes the behavior. The same
  finding contains a second, valid point (the allocation of a cap depends on the order of the rules), so it is
  only partly a false positive; it is counted as one.

Real problems that were not planted are counted as neither hit nor false positive: several models reported
inconsistencies in the discount engine's handling of oversized or negative amounts (named by every model in some
runs), and Sonnet and Haiku also pointed to a weak assertion in the test of #1. Findings that were inaccurate in
wording but right in substance (one DeepSeek finding on #3 A words a detail of the data wrongly) were not counted
as false positives.

### Failures (CR-44-T05)

| Model | Run | Error code | What happened | Cost |
|---|---|---|---|---|
| `deepseek/deepseek-v3.2` | #1 run 1 | `llm_output_invalid` | The model put Chinese reasoning text into a field of its YAML answer (`start_line:` followed by Chinese prose), which broke parsing; PR-Agent could not parse the answer, no review was published and it posted a "Failed to review PR" comment on the pull request. The same pull request reviewed again was fine. | 0.0047 |

All other 44 runs (29 of the 30 required runs) ended with `ok: true` and a review comment. The log of another DeepSeek run shows the
warning "Review output failed schema validation" (the review was still published), and one DeepSeek run of the
medium pull request published a review without any finding ("No major issues detected"), counted as a run with
0 hits, not as a failure. The failure rate is 1 of 6 required runs for DeepSeek and 0 of 6 for every other
model; with this sample size that is a hint, not a rate. The retry rule of CR-31 should be able to cope with
`llm_output_invalid`.

### Security check (CR-44-T06)

The records of all runs (result JSON, comment text, runner output, 135 files) were scanned for the
OpenRouter key, for the first characters of the GitHub App private key and for token patterns (`ghp_`, `ghs_`,
`sk-or-`, PEM headers): no hit. `manual_review.py` also scans the runner output and the comment text for the
installation token and the key of every run and refuses to write the record if one shows up. This report
contains no secret.

## Observations worth keeping

- **Claude tokenizer:** the large pull request, pruned to 32k tokens by PR-Agent, is 45k tokens for Claude. A
  price estimate with 32k input tokens is 29 percent below the real input of a Claude review (the real input is
  40 percent above the estimate). For CR-25's estimate use a factor of 1.4 on the input tokens for Claude models,
  1.3 for Gemini (or take the prompt tokens from the result's `usage` after the first runs).
- **Reasoning tokens decide the cost of Gemini:** the medium pull request cost 0.049 USD with Gemini 3.8 Flash
  (8k to 14k output tokens) against 0.002 USD with Haiku, which gave better findings. A cheap per-token price
  does not mean a cheap review; the default model has to be judged on the measured cost of a review.
- **Speed:** Claude models answered in 14 to 34 s, GPT-5.4 mini in 15 to 54 s, Gemini 21 to 98 s, DeepSeek
  58 to 157 s. For the wait time in the UI the Claude models are the best.
- **Variance:** the same model on the same pull request found different problems in different runs (Haiku found 1 to 3 of 3 and
  GPT-5.4 mini 0 to 2 of 3 on the medium one). Two runs show the tendency, not a stable rate; the follow-up of CR-11
  (give earlier findings to the model) does not change that.

## Recommendation and decision (CR-44-T07)

| Role | Model id | Why |
|---|---|---|
| **Default** | `anthropic/claude-haiku-5.5` | Within the limit by a wide margin (0.0027 USD average, 0.0052 USD largest, about 5 percent of the limit even for a large review), 23 s, no failure and no false positive in 9 runs, both problems of the small and the large pull request in every run, 9 of 15 on the hard medium pull request. |
| Alternative for important repositories | `anthropic/claude-sonnet-5.5` | Best quality in this test (13 of 14, medium 13 of 15). Average 0.049 USD, but 0.100 USD measured and about 0.12 USD estimated with the tokenizer factor for a large pull request, so a project override must show the warning of CR-25 and a large review can exceed the limit. |
| Alternative from another vendor | `openai/gpt-5.4-mini` | 0.015 USD average, 0.026 USD largest, no failure, finds the easy and the large problems, weaker on the medium pull request (6 of 15). |

Exact OpenRouter ids: `anthropic/claude-haiku-5.5`, `anthropic/claude-sonnet-5.5`, `openai/gpt-5.4-mini`;
tested but not recommended: `deepseek/deepseek-v3.2`, `google/gemini-3.8-flash`.

Why not the cheapest or the best: DeepSeek is the cheapest of the original candidates but the slowest, the only
one with a failed run, and it finds fewer problems than Haiku, which is 2.4 times cheaper; Sonnet is better than Haiku by
about 4 of 15 planted problems on the medium pull request at 18 times the average cost, and it is over the limit on a large pull request. Whether that
difference is worth the money is the customer's decision per project; the default should be the model that
always stays under the limit.

Decision log entry (decided by the project lead, see "Decision" above): "Default review model is
`anthropic/claude-haiku-5.5` via OpenRouter (CR-44, measured 0.0027 USD average per review on the playground
pull requests, limit 0.10 USD). Per-project override allowed; alternatives `anthropic/claude-sonnet-5.5` and
`openai/gpt-5.4-mini`. Re-measure when PR-Agent, the prompts or the model list change." The log itself lives
outside this repository.

Limits of this test: three small playground pull requests with planted problems, one language (TypeScript),
two to five runs per cell, one judge (manual). It ranks the models for this kind of problem; it does not
measure how many problems a model finds in a real, large codebase.

## Test cases

| Case | Result |
|---|---|
| CR-44-T01 | Section "Candidates and price calculation": every candidate is below 0.10 USD for the plain estimate of the large review (Sonnet 0.094). With the tokenizer factor Sonnet is about 0.12 USD, so T01 is **not met for Sonnet** (measured 0.1003 USD); the other four stay under the limit in both estimates. |
| CR-44-T02 | 45 recorded reviews (5 models x 3 pull requests x 2 runs = 30, plus runs 3 to 5 of the medium pull request for each model = 15). The appendix lists every run with its result values; all runs of a pull request point to the same comment link, because the comment is edited in place. The comment text of every run was saved right after the run (outside the repository), the result JSON of every run too. |
| CR-44-T03 | Hit rate per model and pull request and per planted problem type above. |
| CR-44-T04 | False positives per model above (one in total, judged and justified). |
| CR-44-T05 | Failures per model with error code above (one: `llm_output_invalid`). |
| CR-44-T06 | Scan of all records, runner output and this report: no secret. |
| CR-44-T07 | Recommendation with the default, two alternatives and the decision log entry (decided by the project lead). |

## Commands

```
set -a; . ~/.config/code-reviewer/dev.env; set +a        # the developer's credentials, never printed
cd runner
uv run python scripts/manual_review.py --yes --pr-url https://github.com/ExpidetGames/code-reviewer-playground/pull/2 \
  --model anthropic/claude-haiku-5.5 --record-dir /path/to/records --label haiku-pr2-run1
```

The loop over models, pull requests and runs was a small shell script (not part of the repository: it spends money).

## Appendix: every run

Runs 1 and 2 are the required runs; runs 3 to 5 exist only for the medium pull request. `Planted found` is
out of 2 (#1), 3 (#2) or 2 (#3). The model's id is the OpenRouter id. The comment link of all runs of a pull
request is the one named in "Method".

| Model | PR | Run | Result | Error code | Duration (s) | Tokens in / out | Cost (USD) | Planted found |
|---|---|---|---|---|---|---|---|---|
| `deepseek/deepseek-v3.2` | 1 | 1 | failed | llm_output_invalid | 58 | 3013 / 2127 | 0.0047 | 0 of 2 |
| `deepseek/deepseek-v3.2` | 1 | 2 | ok | - | 69 | 3013 / 2754 | 0.0049 | 2 of 2 |
| `deepseek/deepseek-v3.2` | 2 | 1 | ok | - | 157 | 7698 / 2843 | 0.0050 | 2 of 3 |
| `deepseek/deepseek-v3.2` | 2 | 2 | ok | - | 63 | 7698 / 2529 | 0.0047 | 0 of 3 |
| `deepseek/deepseek-v3.2` | 2 | 3 | ok | - | 104 | 7698 / 2112 | 0.0027 | 0 of 3 |
| `deepseek/deepseek-v3.2` | 2 | 4 | ok | - | 95 | 7698 / 2768 | 0.0050 | 0 of 3 |
| `deepseek/deepseek-v3.2` | 2 | 5 | ok | - | 100 | 7698 / 2553 | 0.0048 | 2 of 3 |
| `deepseek/deepseek-v3.2` | 3 | 1 | ok | - | 68 | 31526 / 1808 | 0.0096 | 2 of 2 |
| `deepseek/deepseek-v3.2` | 3 | 2 | ok | - | 125 | 31526 / 3686 | 0.0104 | 2 of 2 |
| `anthropic/claude-sonnet-5.5` | 1 | 1 | ok | - | 19 | 4546 / 543 | 0.0145 | 2 of 2 |
| `anthropic/claude-sonnet-5.5` | 1 | 2 | ok | - | 14 | 4546 / 579 | 0.0149 | 2 of 2 |
| `anthropic/claude-sonnet-5.5` | 2 | 1 | ok | - | 19 | 11886 / 681 | 0.0306 | 2 of 3 |
| `anthropic/claude-sonnet-5.5` | 2 | 2 | ok | - | 20 | 11886 / 819 | 0.0320 | 3 of 3 |
| `anthropic/claude-sonnet-5.5` | 2 | 3 | ok | - | 21 | 11886 / 820 | 0.0320 | 3 of 3 |
| `anthropic/claude-sonnet-5.5` | 2 | 4 | ok | - | 20 | 11886 / 799 | 0.0318 | 3 of 3 |
| `anthropic/claude-sonnet-5.5` | 2 | 5 | ok | - | 20 | 11886 / 758 | 0.0314 | 2 of 3 |
| `anthropic/claude-sonnet-5.5` | 3 | 1 | ok | - | 34 | 45032 / 1034 | 0.1004 | 2 of 2 |
| `anthropic/claude-sonnet-5.5` | 3 | 2 | ok | - | 31 | 45032 / 1013 | 0.1002 | 2 of 2 |
| `google/gemini-3.8-flash` | 1 | 1 | ok | - | 25 | 3311 / 2321 | 0.0112 | 1 of 2 |
| `google/gemini-3.8-flash` | 1 | 2 | ok | - | 21 | 3311 / 1662 | 0.0087 | 1 of 2 |
| `google/gemini-3.8-flash` | 2 | 1 | ok | - | 98 | 8834 / 14488 | 0.0610 | 0 of 3 |
| `google/gemini-3.8-flash` | 2 | 2 | ok | - | 60 | 8834 / 8241 | 0.0375 | 0 of 3 |
| `google/gemini-3.8-flash` | 2 | 3 | ok | - | 58 | 8834 / 8483 | 0.0384 | 0 of 3 |
| `google/gemini-3.8-flash` | 2 | 4 | ok | - | 85 | 8834 / 10843 | 0.0473 | 1 of 3 |
| `google/gemini-3.8-flash` | 2 | 5 | ok | - | 78 | 8834 / 11685 | 0.0504 | 0 of 3 |
| `google/gemini-3.8-flash` | 3 | 1 | ok | - | 52 | 40962 / 4165 | 0.0463 | 2 of 2 |
| `google/gemini-3.8-flash` | 3 | 2 | ok | - | 51 | 40962 / 4649 | 0.0482 | 2 of 2 |
| `openai/gpt-5.4-mini` | 1 | 1 | ok | - | 17 | 2918 / 604 | 0.0049 | 2 of 2 |
| `openai/gpt-5.4-mini` | 1 | 2 | ok | - | 15 | 2918 / 487 | 0.0025 | 2 of 2 |
| `openai/gpt-5.4-mini` | 2 | 1 | ok | - | 52 | 7427 / 4302 | 0.0249 | 0 of 3 |
| `openai/gpt-5.4-mini` | 2 | 2 | ok | - | 54 | 7427 / 4905 | 0.0230 | 2 of 3 |
| `openai/gpt-5.4-mini` | 2 | 3 | ok | - | 45 | 7427 / 3841 | 0.0229 | 1 of 3 |
| `openai/gpt-5.4-mini` | 2 | 4 | ok | - | 47 | 7427 / 3864 | 0.0183 | 2 of 3 |
| `openai/gpt-5.4-mini` | 2 | 5 | ok | - | 42 | 7427 / 3276 | 0.0156 | 1 of 3 |
| `openai/gpt-5.4-mini` | 3 | 1 | ok | - | 28 | 30489 / 664 | 0.0259 | 2 of 2 |
| `openai/gpt-5.4-mini` | 3 | 2 | ok | - | 39 | 30489 / 1952 | 0.0114 | 2 of 2 |
| `anthropic/claude-haiku-5.5` | 1 | 1 | ok | - | 17 | 4546 / 1010 | 0.0010 | 2 of 2 |
| `anthropic/claude-haiku-5.5` | 1 | 2 | ok | - | 15 | 4546 / 806 | 0.0009 | 2 of 2 |
| `anthropic/claude-haiku-5.5` | 2 | 1 | ok | - | 24 | 11886 / 1948 | 0.0022 | 2 of 3 |
| `anthropic/claude-haiku-5.5` | 2 | 2 | ok | - | 23 | 11886 / 1968 | 0.0022 | 1 of 3 |
| `anthropic/claude-haiku-5.5` | 2 | 3 | ok | - | 23 | 11886 / 1901 | 0.0021 | 2 of 3 |
| `anthropic/claude-haiku-5.5` | 2 | 4 | ok | - | 24 | 11886 / 2107 | 0.0022 | 1 of 3 |
| `anthropic/claude-haiku-5.5` | 2 | 5 | ok | - | 26 | 11886 / 2583 | 0.0025 | 3 of 3 |
| `anthropic/claude-haiku-5.5` | 3 | 1 | ok | - | 32 | 45032 / 1378 | 0.0052 | 2 of 2 |
| `anthropic/claude-haiku-5.5` | 3 | 2 | ok | - | 30 | 45032 / 1127 | 0.0051 | 2 of 2 |
