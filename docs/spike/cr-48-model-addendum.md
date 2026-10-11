# CR-48 addendum: Claude Opus 5.5 and DeepSeek V4.1 Flash in the CR-44 model comparison

Date: 2026-10-10. Addendum to [`cr-44-model-comparison.md`](cr-44-model-comparison.md). The customer asked to
repeat the CR-44 comparison with exactly two more models: Claude Opus 5.5 and DeepSeek 4.1 Flash. Same method,
same three playground pull requests, same runner (`pr-agent==0.47.0`, command `review`, installation token),
same `runner/scripts/manual_review.py --record-dir --label`. Hard budget: 2.00 USD real spend for both models
together.

## Result in short

- **No change to the default.** `anthropic/claude-haiku-5.5` stays the default review model.
- **`anthropic/claude-opus-5.5` is not recommended.** Cost per review averages **0.118 USD** over the six
  required runs and **0.244 USD** for the large pull request, so it is over the customer's 0.10 USD limit on
  average, not just for large reviews. Quality is good (12 of 14 planted problems in the two required runs, 11 of
  15 on the medium pull request, no false positive, no failure) but not better than `anthropic/claude-sonnet-5.5`
  from CR-44 (13 of 14 and 13 of 15), which costs 0.049 USD on average. Opus costs about 2.4 times Sonnet and 44
  times Haiku.
- **`deepseek/deepseek-v4.1-flash` is cheap and stable, but could not be fully scored.** 0.0041 USD per review on
  average (largest 0.0082 USD), no failed run in 9 runs, both planted problems of the small and of the large pull
  request in every run (8 of 8). **The five runs on the medium pull request could not be scored** because the
  review comment on that pull request ran into GitHub's comment size limit (see "Medium pull request: DeepSeek
  runs not scorable"). Without that number the model cannot be ranked against Haiku (9 of 15 on the medium
  pull request), so the default does not change. In short, good on the easy pull requests, not proven on the hard one: DeepSeek V4.1 Flash is about 50 percent more expensive than Haiku per review (0.0041
  against 0.0027 USD) and about 1.5 times as slow (36 s against 23 s), so even a good medium result would not make it a
  better default.
- **Total spend of this ticket: 1.006 USD** (18 reviews, sum of the cost reported by PR-Agent), against the 2.00
  USD limit. OpenRouter's key usage counter moved from 1.1294 to 2.1261 USD in the same period, i.e. 0.997 USD,
  which agrees (the counter is shared, but no other spending showed up).
- Honest caveats: two runs per pull request (five on the medium one) is a small sample, the evaluation is manual,
  one cell is missing (DeepSeek, medium pull request), and no run was cut for budget (see "Budget and plan").

## Method

Identical to CR-44 ("Method" there), with these facts for the two new models:

- **Pull requests:** `ExpidetGames/code-reviewer-playground` #1 (small), #2 (medium), #3 (large).
- **Settings:** the runner defaults, `llm.maxTokens` 163,840, only `llm.model` differs. The command is `review`.
- **Runs:** per model 2 runs on #1, 5 on #2, 2 on #3 (9 runs per model, as in CR-44). Runs of one pull request ran
  one after the other (a pull request has one review comment that every run edits in place). The pilot run of
  each model on the large pull request is run 1 of that cell.
- **Recording:** every run left its result JSON and the comment text right after the run, outside the repository,
  like in CR-44 (the appendix lists every run). Nothing is written if the installation token or the key shows up.
- **Cost** is `usage.costUsd` of the runner result; **duration** is the runner's `durationMs`.
- **Evaluation** manual against the list of planted problems (kept outside the repository). The planted problems
  are named neutrally: **#1** A and B, **#2** A, B and C, **#3** A and B. A problem counts as found when the
  findings of that run name it; a sentence about it inside a finding about something else is counted as found and
  named as borderline (same rule as CR-44).
- **Where the findings of a run were read:** the visible text of the comment is cut when the comment gets long
  (GitHub allows 65,536 characters, PR-Agent cuts at 65,000). For the medium pull request the findings of each run
  were therefore read from the machine-readable state block of the comment, which lists every finding with the
  time it was last seen; the findings of a run are the ones whose time matches that run. For runs where the
  visible text was complete (all of #1 and #3 and Opus runs 1 to 4 on #2) both agree.

## Model ids and prices (CR-48-T01)

Looked up in OpenRouter's public model list (`https://openrouter.ai/api/v1/models`, no key, fetched 2026-10-10)
before the first paid run. Both have exactly one matching id (the `:batch` variants and the `~...-latest` aliases
exist too and were not used, because they are not the model asked for):

| Model id | Input (USD per M tokens) | Output | Context |
|---|---|---|---|
| `anthropic/claude-opus-5.5` | 4.00 | 20.00 | 1,000,000 |
| `deepseek/deepseek-v4.1-flash` | 0.30 | 1.20 | 1,048,576 |

Other DeepSeek V4 ids exist (`deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro`, `deepseek-v4-flash-0731`),
but "4.1 Flash" matches only `deepseek/deepseek-v4.1-flash`.

Estimate with the CR-44 formula (`32,000 x input price / 1,000,000 + 3,000 x output price / 1,000,000`, large
pull request) and the tokenizer factor of CR-44 (Claude 1.4, DeepSeek and GPT 1.0), compared with the measured
large-pull-request review (average of 2 runs):

| Model | Estimate: 32k in + 3k out | Estimate with tokenizer factor | Measured, large PR (avg of 2) | Input tokens measured | Factor measured |
|---|---|---|---|---|---|
| `anthropic/claude-opus-5.5` | 0.1280 + 0.0600 = **0.1880** | factor 1.4 (44.8k in): **0.2392** | **0.2437** | 54,687 | 1.71 |
| `deepseek/deepseek-v4.1-flash` | 0.0096 + 0.0036 = **0.0132** | factor 1.0: 0.0132 | 0.0050 | 38,343 | 1.20 |

Reading:

- Both are over or near the estimate for the wrong reasons. **Opus is above the plain estimate by 30 percent**
  and slightly above even the Claude-factor estimate, because its real input on the large pull request is 54.7k
  tokens, a factor of 1.71 over the 32k that PR-Agent assumes. That is also 21 percent more than Sonnet and Haiku
  saw for the same pull request in CR-44 (45.0k). On the medium and small pull request the input is identical to
  Sonnet and Haiku (11,886 and 4,546 tokens), because those diffs are not pruned. The likely reason is that
  PR-Agent prunes the large diff by its own token count with a safety margin for the model names it knows, and
  `anthropic/claude-opus-5.5` is not among them, so Opus received more of the large diff (unverified; it was not
  tested). Either way, for CR-25's estimator a factor of **1.7 for Opus** matches the measurement, not 1.4.
- **DeepSeek V4.1 Flash is below the estimate**: 38.3k input tokens (factor 1.20, against about 31.5k for V3.2 in
  CR-44), but the billed cost is far lower than the list price times the tokens. List price for the two large
  runs would be 0.0164 and 0.0153 USD; the reported costs are 0.0082 and 0.0019 USD. The same effect shows on the
  other runs (the medium run 1 would be 0.0114 USD at list price and cost 0.0063). **The cause is unknown.**
  Cached input tokens billed at a lower price would be one hypothesis, but it does not explain the numbers: several
  runs cost less than the list price of their output tokens alone (large run 2: 3,125 output tokens are 0.0038 USD
  at list price, the run cost 0.0019 USD), and the runner result has no cache field. It was not investigated
  further. It matters for how the costs below are read: the measured DeepSeek costs are what OpenRouter charged,
  but they may be lower than what a later review of another pull request costs. At list price DeepSeek would cost
  about 0.015 USD for the large pull request (estimate 0.0132, measured tokens 0.0151), still a fraction of the
  limit.
- The reported cost agrees with the real bill: the sum of the reported costs (1.0059 USD) is 1 percent above the
  increase of OpenRouter's key usage counter over the whole ticket (0.997 USD). For Opus the cost equals list
  price times tokens exactly.

## Budget and plan (CR-48-T02, T03, T04)

| Step | What | Cost (USD) | Running total (USD) |
|---|---|---|---|
| Pilot Opus | #3, 1 run (= run 1 of the cell) | 0.2419 | 0.2419 |
| Pilot DeepSeek | #3, 1 run (= run 1 of the cell) | 0.0082 | 0.2501 |

Projection after the pilot: Opus input tokens scale from the pilot (small about 4.5k, medium about 11.9k, large
54.7k) and output about 0.5k to 1.8k tokens: a small review about 0.03 USD, a medium one about 0.08 USD, the large
one 0.24 USD, so the full plan of 9 runs is about 0.94 USD (2 x 0.03 + 5 x 0.08 + 2 x 0.24). DeepSeek about 0.05
USD. Total about 0.99 USD, and 1.14 USD with the 15 percent margin, below 2.00 USD. **No run had to be cut**, the
full plan of 9 runs per model ran. The running total was tracked after every run (every cost read from the result
JSON, together with a check that the next run could not cross 2.00 USD); the end result is 1.006 USD, the
projection was within 2 percent.

| Item | USD |
|---|---|
| 9 runs `anthropic/claude-opus-5.5` | 0.9592 |
| 9 runs `deepseek/deepseek-v4.1-flash` | 0.0467 |
| **Total (CR-48-T04)** | **1.0059** |

The five DeepSeek runs on the medium pull request that could not be scored are included in the total (0.0316
USD). No other paid call was made. A few attempts to start runs or to edit the playground were refused by the
sandbox of this work session before they started and cost nothing.

## Results (CR-48-T03)

Required runs: two per model and pull request (runs 1 and 2). "Planted found" is out of (problems x runs): small
2 x 2 = 4, medium 3 x 2 = 6, large 2 x 2 = 4. Cost and duration are over the six required runs of a model, as in
CR-44. The five CR-44 models are repeated from the CR-44 report for the comparison.

| Model | Hit rate small (#1) | Hit rate medium (#2) | Hit rate large (#3) | Total | False positives | Failures | Cost avg / max (USD) | Duration avg / max (s) |
|---|---|---|---|---|---|---|---|---|
| `anthropic/claude-opus-5.5` (CR-48) | 4 of 4 | 4 of 6 | 4 of 4 | **12 of 14** | 0 | 0 | 0.1179 / **0.2456** | 30 / 44 |
| `deepseek/deepseek-v4.1-flash` (CR-48) | 4 of 4 | **not scorable** (see below) | 4 of 4 | 8 of 8 (medium missing) | 0 (small and large) | 0 | **0.0041** / 0.0082 | 36 / 52 |
| `anthropic/claude-sonnet-5.5` | 4 of 4 | 5 of 6 | 4 of 4 | 13 of 14 | 1 | 0 | 0.0488 / 0.1004 | 23 / 34 |
| `anthropic/claude-haiku-5.5` (default) | 4 of 4 | 3 of 6 | 4 of 4 | 11 of 14 | 0 | 0 | 0.0027 / 0.0052 | 23 / 32 |
| `openai/gpt-5.4-mini` | 4 of 4 | 2 of 6 | 4 of 4 | 10 of 14 | 0 | 0 | 0.0154 / 0.0259 | 34 / 54 |
| `deepseek/deepseek-v3.2` (reference) | 2 of 4 | 2 of 6 | 4 of 4 | 8 of 14 | 0 | 1 (`llm_output_invalid`) | 0.0066 / 0.0104 | 96 / 157 |
| `google/gemini-3.8-flash` | 2 of 4 | 0 of 6 | 4 of 4 | 6 of 14 | 0 | 0 | 0.0355 / 0.0610 | 51 / 98 |

Over all nine runs the averages are: Opus 0.1066 USD and 31 s (largest 43.6 s), DeepSeek V4.1 Flash 0.0052 USD
and 44 s (largest 71 s, the slow ones are the long reasoning runs on the medium pull request, 4.7k to 13.8k
output tokens).

Cost per size (average of the two required runs, USD):

| Model | Small (#1) | Medium (#2) | Large (#3) |
|---|---|---|---|
| `deepseek/deepseek-v4.1-flash` | 0.0025 | 0.0047 | 0.0050 |
| `anthropic/claude-haiku-5.5` | 0.0009 | 0.0022 | 0.0051 |
| `deepseek/deepseek-v3.2` | 0.0048 | 0.0049 | 0.0100 |
| `openai/gpt-5.4-mini` | 0.0037 | 0.0240 | 0.0186 |
| `anthropic/claude-sonnet-5.5` | 0.0147 | 0.0313 | 0.1003 |
| `google/gemini-3.8-flash` | 0.0100 | 0.0492 | 0.0472 |
| `anthropic/claude-opus-5.5` | 0.0288 | 0.0812 | 0.2437 |

### Per planted problem (CR-48, same table as CR-44-T03)

"Found" is runs with the problem named, out of the runs. The medium pull request is shown for all five runs.

| Model | #1 A | #1 B | #2 A (5 runs) | #2 B (5 runs) | #2 C (5 runs) | #3 A | #3 B |
|---|---|---|---|---|---|---|---|
| `anthropic/claude-opus-5.5` | 2 of 2 | 2 of 2 | 2 of 5 | 5 of 5 | 4 of 5 | 2 of 2 | 2 of 2 |
| `deepseek/deepseek-v4.1-flash` | 2 of 2 | 2 of 2 | not scorable | not scorable | not scorable | 2 of 2 | 2 of 2 |
| `anthropic/claude-sonnet-5.5` (CR-44) | 2 of 2 | 2 of 2 | 4 of 5 | 5 of 5 | 4 of 5 | 2 of 2 | 2 of 2 |
| `anthropic/claude-haiku-5.5` (CR-44) | 2 of 2 | 2 of 2 | 4 of 5 | 1 of 5 | 4 of 5 | 2 of 2 | 2 of 2 |

Hit rates over the five runs of the medium pull request (of 15): Opus **11** (strict count without the one
borderline call: 10), Sonnet 13, Haiku 9, GPT-5.4 mini 6, DeepSeek V3.2 4, Gemini 1, DeepSeek V4.1 Flash not
scorable.

Reading: Opus finds #2 B in every run and #2 C in four of five, like Sonnet, but #2 A only in two of five runs
(Sonnet and Haiku four of five). Opus therefore ends below Sonnet on the medium pull request even though it is
the larger, more expensive model. #1 and #3 are found by every model that was scored there, as in CR-44. For
#2 A: found in two of five runs (one of them borderline, see below), not found in the other three.

Notes on borderline calls: one. In Opus medium run 4 (not a required run) #2 A is named in one sentence of a
finding about something else, and is counted as found like the comparable calls in CR-44; strict counting
gives 10 of 15 instead of 11. The required-run total (12 of 14) does not depend on it.

### Medium pull request: DeepSeek runs not scorable

The five DeepSeek V4.1 Flash runs (and nothing else) on #2 ended with `ok: true` and a comment link, but their
findings cannot be read. The review comment of a pull request carries a state block with every finding of every
earlier review (PR-Agent keeps this state to follow findings across runs). After the 45 reviews of CR-44 and the
five Opus runs the block held 93 findings and filled the 65,000 characters that PR-Agent can publish. The log
of each DeepSeek run says it: "Persistent review state did not fit the provider comment limit; publishing the
review without advancing state". The visible review was cut to its first finding ("..."), and the state block was
not updated, so the other findings of the run are lost; the first, cut finding of each run is not one of the
planted problems. The cost, tokens and duration of these five runs were recorded and are in the tables, only the
hit rate is missing.

The fix would be to empty the review comment of #2 (one edit of the bot's own comment) and run DeepSeek V4.1
Flash five more times on #2, about 0.03 USD. The edit was refused by the sandbox of this work session, because it
changes the playground, which was not part of the ticket, so it is left to the project lead (follow-up in the
pull request). The runner reports `ok: true` for such a run, which is a risk for the product itself (see
"Observations").

### False positives (CR-48-T04 of the CR-44 list)

None in the 18 runs. Both models also made remarks beyond the planted problems that are real; like in CR-44 they
count as neither hit nor false positive.

### Failures

None. 18 of 18 runs ended with `ok: true` and a review comment (the cut comments of the five unscorable runs are
a comment size issue, not a model failure). DeepSeek V4.1 Flash had no `llm_output_invalid`, unlike V3.2 in CR-44
(1 of 6).

### Security check

The records of all 18 runs (result JSON, comment text and runner output, 54 files) were scanned for the
OpenRouter key, the first characters of the GitHub App private key and token patterns (`ghp_`, `ghs_`, `sk-or-`,
PEM headers) before this report was written. `manual_review.py` also refuses to write a record if the
installation token or the key shows up. This report names no planted problem, only #1 A/B, #2 A/B/C and #3 A/B.

## Observations

- **Opus gets the largest input of all models on the large pull request** (54.7k tokens), which is part of why it
  costs 0.24 USD. A price estimate for Opus needs factor 1.7 on the 32k tokens PR-Agent assumes, not 1.4.
- **Price is not quality.** Opus (0.118 USD average) found fewer planted problems on the medium pull request (11 of
  15) than Sonnet (13 of 15, 0.049 USD average), at 44 times the price of Haiku (9 of 15). One problem (#2 A) was
  found in only 2 of 5 Opus runs, so a single run of any model, however large, shows a tendency, not a guarantee.
- **DeepSeek V4.1 Flash reasons long on the medium pull request** (4.7k to 13.8k output tokens, 34 to 71 s) but
  stays cheap because output is 1.20 USD per million tokens. On small and large pull requests it is fast and
  finds both problems of each in every run.
- **Product risk found by this test:** when the persistent state of a pull request grows (here 93 findings), the
  review comment reaches GitHub's size limit, PR-Agent cuts the visible findings to the first one, stops advancing
  the state, and the runner still reports `ok: true` with a comment link. A real project with many reviews of one
  pull request can lose findings silently. For CR-31/CR-25 (retry and failure handling) this is worth a ticket:
  detect the warning "Persistent review state did not fit the provider comment limit" in the runner log and either
  fail the run with a stable error code or pass a smaller state.

## Recommendation (CR-48-T05)

| Role | Model id | Change |
|---|---|---|
| **Default** | `anthropic/claude-haiku-5.5` | **No change.** Average 0.0027 USD, 23 s, no failure, no false positive, both problems of the small and large pull request in every run, 9 of 15 on the medium pull request. Neither new model beats it on value. |
| Alternative for important repositories | `anthropic/claude-sonnet-5.5` | **No change.** Still the best quality in the comparison (13 of 14, medium 13 of 15) at 0.049 USD average, and Opus 5.5 does not improve on it. |
| Not recommended | `anthropic/claude-opus-5.5` | Over the 0.10 USD limit on average (0.118) and on every large review (0.244 USD), no quality gain over Sonnet. If the customer still wants it for a single project, show the CR-25 warning with factor 1.7 on the input tokens. |
| Candidate, undecided | `deepseek/deepseek-v4.1-flash` | Cheap (0.0041 USD average), stable (0 failures in 9), strong on #1 and #3, but the medium pull request is not scored. Rerun that one cell (about 0.03 USD, needs the comment of #2 emptied) before deciding if it should replace `deepseek/deepseek-v3.2` as the cheap second-vendor alternative. It is a clear improvement over V3.2 in reliability and speed; it is not a better default than Haiku. |

Decision log entry suggested for the project lead: "CR-48: Claude Opus 5.5 (0.118 USD average, 0.244 USD per
large review, 12 of 14) and DeepSeek V4.1 Flash (0.0041 USD average, small and large pull request fully found,
medium pull request not scorable) were measured with the CR-44 method; the default model stays
`anthropic/claude-haiku-5.5`. Re-measure when PR-Agent, the prompts or the model list change."

Limits of this test: the same as in CR-44 (three small playground pull requests, one language, two to five
runs per cell, one manual judge), plus the missing DeepSeek medium cell, and the unexplained gap between DeepSeek's
reported cost and its list price (see "Model ids and prices").

## Test cases

| Case | Result |
|---|---|
| CR-48-T01 | Section "Model ids and prices": both ids exist at OpenRouter (`anthropic/claude-opus-5.5`, `deepseek/deepseek-v4.1-flash`), prices and the estimate are in the report, written before the first paid run. |
| CR-48-T02 | Pilot of each model on the large pull request (Opus 0.2419 USD, DeepSeek 0.0082 USD), measured cost, projection of the full plan (about 0.99 USD, 1.14 USD with margin). |
| CR-48-T03 | Full plan of CR-44 (2 runs per pull request, 5 on the medium one) ran for both models, nothing cut; results in the same tables as CR-44. One cell (DeepSeek, medium pull request) is marked as not scorable and explained. |
| CR-48-T04 | Total spend 1.0059 USD (limit 2.00 USD), per model and in total in "Budget and plan". |
| CR-48-T05 | Section "Recommendation": the default stays `anthropic/claude-haiku-5.5`. |
| CR-48-T06 | This report names the problems only as #1 A/B, #2 A/B/C, #3 A/B. |

## Commands

```
set -a; . ~/.config/code-reviewer/dev.env; set +a        # the developer's credentials, never printed
cd runner
uv run python scripts/manual_review.py --yes --pr-url https://github.com/ExpidetGames/code-reviewer-playground/pull/2 \
  --model anthropic/claude-opus-5.5 --record-dir /path/to/records --label opus-pr2-run1
```

Model ids: `anthropic/claude-opus-5.5`, `deepseek/deepseek-v4.1-flash`. The records stay outside the repository,
as in CR-44.

## Appendix: every run

`Planted found` is out of 2 (#1), 3 (#2) or 2 (#3). Comment links: the same as in CR-44, #1
`issuecomment-6097473386`, #2 `issuecomment-6098095542`, #3 `issuecomment-6098167593` (the comments are edited in
place). Duration is the runner's `durationMs`.

| Model | PR | Run | Result | Error code | Duration (s) | Tokens in / out | Cost (USD) | Planted found |
|---|---|---|---|---|---|---|---|---|
| `anthropic/claude-opus-5.5` | 1 | 1 | ok | - | 17 | 4546 / 517 | 0.0285 | 2 of 2 |
| `anthropic/claude-opus-5.5` | 1 | 2 | ok | - | 18 | 4546 / 543 | 0.0290 | 2 of 2 |
| `anthropic/claude-opus-5.5` | 2 | 1 | ok | - | 31 | 11886 / 1633 | 0.0802 | 2 of 3 |
| `anthropic/claude-opus-5.5` | 2 | 2 | ok | - | 34 | 11886 / 1733 | 0.0822 | 2 of 3 |
| `anthropic/claude-opus-5.5` | 2 | 3 | ok | - | 33 | 11886 / 1822 | 0.0840 | 2 of 3 |
| `anthropic/claude-opus-5.5` | 2 | 4 | ok | - | 34 | 11886 / 1859 | 0.0847 | 3 of 3 (1 borderline) |
| `anthropic/claude-opus-5.5` | 2 | 5 | ok | - | 33 | 11886 / 1775 | 0.0830 | 2 of 3 |
| `anthropic/claude-opus-5.5` | 3 | 1 | ok | - | 44 | 54687 / 1157 | 0.2419 | 2 of 2 |
| `anthropic/claude-opus-5.5` | 3 | 2 | ok | - | 38 | 54687 / 1341 | 0.2456 | 2 of 2 |
| `deepseek/deepseek-v4.1-flash` | 1 | 1 | ok | - | 16 | 3040 / 1088 | 0.0022 | 2 of 2 |
| `deepseek/deepseek-v4.1-flash` | 1 | 2 | ok | - | 15 | 3040 / 1597 | 0.0028 | 2 of 2 |
| `deepseek/deepseek-v4.1-flash` | 2 | 1 | ok | - | 47 | 7724 / 7590 | 0.0063 | not scorable |
| `deepseek/deepseek-v4.1-flash` | 2 | 2 | ok | - | 34 | 7724 / 4731 | 0.0032 | not scorable |
| `deepseek/deepseek-v4.1-flash` | 2 | 3 | ok | - | 45 | 7724 / 6959 | 0.0046 | not scorable |
| `deepseek/deepseek-v4.1-flash` | 2 | 4 | ok | - | 66 | 7724 / 12512 | 0.0083 | not scorable |
| `deepseek/deepseek-v4.1-flash` | 2 | 5 | ok | - | 71 | 7724 / 13783 | 0.0092 | not scorable |
| `deepseek/deepseek-v4.1-flash` | 3 | 1 | ok | - | 52 | 38343 / 4096 | 0.0082 | 2 of 2 |
| `deepseek/deepseek-v4.1-flash` | 3 | 2 | ok | - | 51 | 38343 / 3125 | 0.0019 | 2 of 2 |
