# CR-50: fair model comparison, every model under identical conditions

Date: 2026-10-10. Data and blind scoring are final. The recommendation (CR-50-T06) is **pending customer
decision**.

Follow-up to [`cr-44-model-comparison.md`](cr-44-model-comparison.md) and the CR-48 addendum
(`cr-48-model-addendum.md`, branch `CR-48-model-addendum`). In CR-44 and CR-48 every run on a playground pull
request edited the same persistent review comment, so later models ran with the finding state of earlier ones (and
DeepSeek V4.1 Flash hit GitHub's comment size limit). Here every run is a first review.

## Result in short

- **84 counted runs: 7 models x 3 pull requests x 4 runs.** Every cell has exactly 4 successful runs. 86 runs were
  started; two were repeated because a network outage on the developer machine ate their result (see "Failures").
- **Total real spend of this ticket: 2.9075 USD** (sum of `usage.costUsd` of all 86 runs, of which 2.8554 USD for
  the 84 counted runs and 0.0521 USD for one paid run whose comment text was lost in the outage). The limit was
  5.00 USD. OpenRouter's key usage counter moved from 2.1353 to 5.0428 USD over the ticket, i.e. **2.9075 USD**,
  which agrees with the sum of the runs to four decimals. (The absolute counter is above 5 because the key had
  2.1353 USD of earlier spending from CR-44/CR-48; the key limit is 50 USD.)
- **Before every run no bot comment existed on the pull request** (checked through the API, recorded per run,
  86 of 86). 88 comments of our own bot were deleted in total, nothing else was touched.
- No run was cut for budget. No model failure: 84 of 84 counted runs ended with `ok: true` and a review comment,
  no comment came near the size limit (largest 7,099 characters), and no log showed "Persistent review state did
  not fit".
- **Blind-scored hit rates (found of 28):** Sonnet 24 (+1 borderline), DeepSeek V4.1 Flash 23, Opus 22 (+2), Haiku 22
  (+2), GPT-5.4 mini 18 (+2), DeepSeek V3.2 14 (+2), Gemini 12. False positives: 4 in 84 runs (Haiku 2, GPT-5.4 mini 2).
  See "Hit rates" and "Results" for cost and duration.

## Method

- **Pull requests:** `ExpidetGames/code-reviewer-playground` #1 (small), #2 (medium), #3 (large), as in CR-44.
- **Runner and command:** `pr-agent==0.47.0` through the runner entry point (`code-reviewer-run-job`), started
  by `runner/scripts/manual_review.py --record-dir --label` with an installation token, command `review`, models
  through OpenRouter. Identical for every model; only `llm.model` differs.
- **Identical start state:** before every run the review comment(s) written by our own GitHub App bot
  (`code-reviewer-dev-expidetgames[bot]`) on the pull request are deleted with the App's installation token, then
  the API is asked for the comments of the pull request and the run starts only if no comment of the bot is left.
  So every run is a first review, with no finding state from any earlier run. The customer authorised exactly this
  (comments of our own bot, in this private repository, on these three pull requests, for this ticket); the driver
  script refuses any other author, any other pull request and any other kind of object. Per run the check is kept
  as a `precheck.json` record (comments before, ids deleted, comments after = 0, bot comments after = 0, no inline
  review comments or reviews by the bot). Deleted in total: 88 bot comments (4 on #1 at the start, because earlier tickets left small comments there,
  otherwise 1 per run; none before the run after the failed Sonnet run, because that run published nothing). The last run on each pull request left its comment in place.
- **Same number of runs:** 4 runs per pull request and model (12 per model, 84 in total), chosen after the pilot
  (see "Pilot and plan"). Runs on one pull request ran one after the other; in fact all runs ran strictly one after
  the other (no parallel streams), so durations are not affected by parallel load.
- **Mixed order:** for every round (1 to 4) and pull request the order of the seven models is a random permutation
  (`random.Random(seed).shuffle`, **seed 980016226**; the driver prints the whole schedule with
  `fair_runs.py plan --seed 980016226 --rounds 4`). The pilot is round 1 of pull request #3.
- **Cost** is `usage.costUsd` of the runner result (PR-Agent, from the token counts and OpenRouter prices),
  **duration** is the runner's `durationMs`. Both are measured for every run and listed in the appendix.
- **Blind preparation:** after every run the comment text is saved under a random 6-character id, with model names
  scrubbed (the scrub found nothing to remove in any of the 84 comments; the comments never contain the model
  name), and the pull request number is the only thing in `index.csv` (`id,pr`, sorted by id, not by run order).
  The mapping `id -> model, run, cost, duration` is kept separately. The scorer got only the comment files and
  `index.csv`. **The developer did not score**; the scorer never saw the mapping. The anonymous comments contain no "resolved findings" section and no
  earlier state (checked: 0 of 84).
- **Scoring (for the scorer, per CR-44):** a planted problem counts as found when the findings of that run name it;
  a sentence about it inside a finding about something else counts as found and is named as borderline. The problems
  are named neutrally: **#1** A and B, **#2** A, B and C, **#3** A and B.
- The driver script is in this repository: [`data/cr-50/fair_runs.py`](data/cr-50/fair_runs.py). The raw records
  (result JSON, comment text, runner output, precheck) stay outside the repository, as in CR-44.

## Model ids and prices (CR-50-T01)

Looked up in OpenRouter's public model list (`https://openrouter.ai/api/v1/models`, no key, fetched 2026-10-10)
before the first paid run. Every id exists exactly once (the `:batch` variants and `deepseek/deepseek-v3.2-exp`
exist as well and were not used, because they are not the model asked for). Prices in USD per million tokens:

| Model id | Input | Output | Context |
|---|---|---|---|
| `anthropic/claude-haiku-5.5` | 0.10 | 0.50 | 1,000,000 |
| `anthropic/claude-sonnet-5.5` | 2.00 | 10.00 | 1,000,000 |
| `anthropic/claude-opus-5.5` | 4.00 | 20.00 | 1,000,000 |
| `openai/gpt-5.4-mini` | 0.75 | 4.50 | 400,000 |
| `google/gemini-3.8-flash` | 0.75 | 3.75 | 1,048,576 |
| `deepseek/deepseek-v3.2` | 0.259 | 0.80 | 163,840 |
| `deepseek/deepseek-v4.1-flash` | 0.30 | 1.20 | 1,048,576 |

Haiku 5.5 lists higher prices above 100,000 prompt tokens (0.50 input, 2.50 output); no review reached that.

## Settings, identical for every model (CR-50-T03)

Recorded once. Source: `runner/src/code_reviewer_runner/pr_agent_config.py` (job to PR-Agent settings),
`runner/scripts/manual_review.py` (job) and the defaults of the installed PR-Agent 0.47.0
(`pr_agent/settings/configuration.toml`). Nothing differs between models except `llm.model`.

| Setting | Value |
|---|---|
| PR-Agent | `pr-agent==0.47.0`, runner entry point `code-reviewer-run-job`, fresh process per run |
| Command | `review` (no arguments, no extra instructions) |
| Model roles | `config.model`, `config.model_weak`, `config.model_reasoning` all set to the job model; no fallback models |
| Token budget | `llm.maxTokens` 163,840, so `config.max_model_tokens` and `config.custom_model_max_tokens` both 163,840 (PR-Agent default clamp 32,000 is lifted). The diff is sent whole: "Tokens: 37142, total tokens under limit: 163840, returning full diff" for #3 in every run |
| Output limit | `config.max_output_tokens` 0 (not set, the provider's own limit applies); `ai_timeout` 120 s |
| Number of findings | `pr_reviewer.num_max_findings` 3 (default) |
| Sampling | `config.temperature` 0.2 and `config.reasoning_effort` "medium" (defaults); `seed` -1. See the observation on reasoning below |
| Review output | defaults: effort estimate, tests, security, ticket analysis on; `persistent_comment` and `persistent_finding_state` on (no state exists because the comment is deleted before the run) |
| Context | default `repo_context_files = ["AGENTS.md"]`, taken from the default branch |
| Publishing | review labels off, no progress comment, no "updated" comment, `output_run_cost` on |
| Repository settings | global settings file off, per-directory settings off; no `job.env` options |
| Run protocol | first review on an empty pull request (all bot comments deleted and verified), one run at a time |

**Same setting, different effect.** PR-Agent passes `reasoning_effort = medium` to OpenRouter only for models it
considers reasoning-capable. The logs show "Adding OpenRouter reasoning {'effort': 'medium'}" for `openai/gpt-5.4-mini`,
`google/gemini-3.8-flash` and `deepseek/deepseek-v3.2`, and no such line for the three Claude models and
`deepseek/deepseek-v4.1-flash`. The setting is the same for all; the effect is PR-Agent's, not ours. This is
part of what the models cost in output tokens (Gemini and DeepSeek V4.1 Flash wrote about 11k to 12k output tokens on average on #2).
Input token counts also differ per model for the same diff because every vendor counts tokens differently
(#3: 54,687 for the Claude models, 49,864 Gemini, 37,103 GPT, 38,343 DeepSeek V4.1 Flash, 38,317 to 38,320 for DeepSeek V3.2 in three runs and 48,953 in the pilot run);
that is not a setting.

## Pilot and plan (CR-50-T01)

Pilot: one run per model on the large pull request #3 (run 1 of that cell), in the random order of round 1.

| Model | Cost (USD) | Duration (s) | Tokens in / out |
|---|---|---|---|
| `anthropic/claude-haiku-5.5` | 0.0062 | 37 | 54687 / 1510 |
| `openai/gpt-5.4-mini` | 0.0312 | 34 | 37103 / 758 |
| `anthropic/claude-sonnet-5.5` | 0.1183 | 31 | 54687 / 893 |
| `deepseek/deepseek-v3.2` | 0.0112 | 109 | 48953 / 3242 |
| `google/gemini-3.8-flash` | 0.0481 | 43 | 49864 / 2866 |
| `anthropic/claude-opus-5.5` | 0.2421 | 36 | 54687 / 1169 |
| `deepseek/deepseek-v4.1-flash` | 0.0021 | 55 | 38343 / 3563 |
| **Pilot total** | **0.4592** | | |

**Projection.** Large pull request: the pilot costs (0.4592 USD per round of seven models). Small and medium pull
request: the averages measured per size in CR-44 and CR-48 (per round of seven models: small 0.0654 USD, medium
0.1975 USD). One round (each model once on #1, #2, #3) is therefore about 0.72 USD.

| Plan | Runs | Projection | With 15 % margin | Fits 4.25 USD? |
|---|---|---|---|---|
| 4 runs per pull request and model | 84 | 4 x 0.7221 = 2.89 | 3.32 | yes |
| 3 runs per pull request and model | 63 | 2.17 | 2.49 | (not needed) |

The rule was "4 runs per pull request only if the projection with margin is at most 4.25 USD". It is 3.32 USD, so
**4 runs per pull request and model were run.** The measured result for the 84 counted runs is 2.855 USD, 1 percent
below the projection of 2.89. The running total was tracked after every run (read from the result JSON), together
with a check that the next run could not cross the limit (worst-case cost of the next run plus the running total
below 4.85 USD); the guard never triggered.

## Results

All numbers are over the 84 counted runs (12 per model). Cost and duration per run are in the appendix.

### Cost and duration per model

| Model | Runs | Failed | Cost avg (USD) | Cost max (USD) | Cost sum (USD) | Duration avg (s) | Duration max (s) |
|---|---|---|---|---|---|---|---|
| `anthropic/claude-haiku-5.5` | 12 | 0 | 0.0030 | 0.0063 | 0.0362 | 22 | 37 |
| `anthropic/claude-sonnet-5.5` | 12 | 0 | 0.0552 | 0.1200 | 0.6626 | 22 | 33 |
| `anthropic/claude-opus-5.5` | 12 | 0 | 0.1171 | 0.2427 | 1.4047 | 27 | 36 |
| `openai/gpt-5.4-mini` | 12 | 0 | 0.0176 | 0.0331 | 0.2109 | 29 | 50 |
| `google/gemini-3.8-flash` | 12 | 0 | 0.0357 | 0.0534 | 0.4280 | 45 | 77 |
| `deepseek/deepseek-v3.2` | 12 | 0 | 0.0057 | 0.0130 | 0.0686 | 129 | 212 |
| `deepseek/deepseek-v4.1-flash` | 12 | 0 | 0.0037 | 0.0137 | 0.0445 | 63 | 256 |

Cost per size, average of 4 runs (USD):

| Model | Small (#1) | Medium (#2) | Large (#3) |
|---|---|---|---|
| `anthropic/claude-haiku-5.5` | 0.0008 | 0.0021 | 0.0062 |
| `anthropic/claude-sonnet-5.5` | 0.0145 | 0.0318 | 0.1194 |
| `anthropic/claude-opus-5.5` | 0.0289 | 0.0810 | 0.2413 |
| `openai/gpt-5.4-mini` | 0.0043 | 0.0199 | 0.0286 |
| `google/gemini-3.8-flash` | 0.0084 | 0.0490 | 0.0495 |
| `deepseek/deepseek-v3.2` | 0.0020 | 0.0034 | 0.0118 |
| `deepseek/deepseek-v4.1-flash` | 0.0006 | 0.0079 | 0.0026 |

Tokens, average of 4 runs per cell:

| Model | Input tokens #1 | #2 | #3 | Output tokens avg #1 | #2 | #3 |
|---|---|---|---|---|---|---|
| `anthropic/claude-haiku-5.5` | 4546 | 11886 | 54687 | 731 | 1727 | 1408 |
| `anthropic/claude-sonnet-5.5` | 4546 | 11886 | 54687 | 537 | 801 | 1002 |
| `anthropic/claude-opus-5.5` | 4546 | 11886 | 54687 | 536 | 1674 | 1126 |
| `openai/gpt-5.4-mini` | 2918 | 7427 | 37103 | 572 | 3435 | 865 |
| `google/gemini-3.8-flash` | 3311 | 8834 | 49864 | 1588 | 11308 | 3233 |
| `deepseek/deepseek-v3.2` | 3013 | 7700 | 40977 | 1611 | 2913 | 3072 |
| `deepseek/deepseek-v4.1-flash` | 3039 | 7724 | 38343 | 695 | 11896 | 4042 |

### Total spend (CR-50-T05)

| Item | USD |
|---|---|
| 84 counted runs | 2.8554 |
| Run whose comment text was lost in the outage (Gemini, #3, round 3; repeated) | 0.0521 |
| Failed run before the model was called (Sonnet, #3, round 3; repeated) | 0.0000 |
| **Total (sum of `usage.costUsd` of 86 runs)** | **2.9075** |
| OpenRouter key counter before (2.1353) and after (5.0428) | 2.9075 |

Per model (counted runs): Haiku 0.0362, Sonnet 0.6626, Opus 1.4047, GPT-5.4 mini 0.2109, Gemini 0.4280 (+0.0521 for
the lost run), DeepSeek V3.2 0.0686, DeepSeek V4.1 Flash 0.0445.

## Hit rates (CR-50-T04)

Scored blind: a separate scorer read the 84 anonymous comments in `index.csv` order without model names, run
order or cost, and recorded a verdict per comment and planted problem (`found`, `borderline`, `missed`) plus,
per comment, the number of false positives and of extra valid findings. The mapping was applied only after
the scoring was complete. Possible per cell: small 2 problems x 4 runs = 8, medium 3 x 4 = 12, large 2 x 4 = 8,
total 28. "(+n)" is the number of borderline calls on top of the found ones; they are not added to the totals.
The table is ordered by found, then borderline.

| Model | Small (#1, of 8) | Medium (#2, of 12) | Large (#3, of 8) | **Total found (of 28)** | Borderline (extra) | False positives | Extra valid findings |
|---|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-5.5` | 8 | 8 (+1) | 8 | **24** | 1 | 0 | 6 |
| `deepseek/deepseek-v4.1-flash` | 8 | 8 | 7 | **23** | 0 | 0 | 3 |
| `anthropic/claude-haiku-5.5` | 8 | 6 (+2) | 8 | **22** | 2 | 2 | 2 |
| `anthropic/claude-opus-5.5` | 8 | 6 (+2) | 8 | **22** | 2 | 0 | 8 |
| `openai/gpt-5.4-mini` | 6 | 4 (+2) | 8 | **18** | 2 | 2 | 2 |
| `deepseek/deepseek-v3.2` | 8 | 0 | 6 (+2) | **14** | 2 | 0 | 2 |
| `google/gemini-3.8-flash` | 4 | 0 | 8 | **12** | 0 | 0 | 4 |

Per planted problem (runs with the problem found, out of 4; "(+n)" borderline):

| Model | #1 A | #1 B | #2 A | #2 B | #2 C | #3 A | #3 B |
|---|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-5.5` | 4 of 4 | 4 of 4 | 2 (+1) of 4 | 4 of 4 | 2 of 4 | 4 of 4 | 4 of 4 |
| `deepseek/deepseek-v4.1-flash` | 4 of 4 | 4 of 4 | 4 of 4 | 0 of 4 | 4 of 4 | 4 of 4 | 3 of 4 |
| `anthropic/claude-haiku-5.5` | 4 of 4 | 4 of 4 | 2 of 4 | 2 (+2) of 4 | 2 of 4 | 4 of 4 | 4 of 4 |
| `anthropic/claude-opus-5.5` | 4 of 4 | 4 of 4 | 0 of 4 | 2 (+2) of 4 | 4 of 4 | 4 of 4 | 4 of 4 |
| `openai/gpt-5.4-mini` | 4 of 4 | 2 of 4 | 4 of 4 | 0 (+2) of 4 | 0 of 4 | 4 of 4 | 4 of 4 |
| `deepseek/deepseek-v3.2` | 4 of 4 | 4 of 4 | 0 of 4 | 0 of 4 | 0 of 4 | 4 of 4 | 2 (+2) of 4 |
| `google/gemini-3.8-flash` | 4 of 4 | 0 of 4 | 0 of 4 | 0 of 4 | 0 of 4 | 4 of 4 | 4 of 4 |

False positives and extra valid findings per pull request (counts over the 4 runs of the cell):

| Model | FP #1 | FP #2 | FP #3 | Extra valid #1 | #2 | #3 |
|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-5.5` | 0 | 0 | 0 | 3 | 3 | 0 |
| `deepseek/deepseek-v4.1-flash` | 0 | 0 | 0 | 0 | 3 | 0 |
| `anthropic/claude-haiku-5.5` | 0 | 1 | 1 | 0 | 1 | 1 |
| `anthropic/claude-opus-5.5` | 0 | 0 | 0 | 4 | 4 | 0 |
| `openai/gpt-5.4-mini` | 0 | 1 | 1 | 0 | 2 | 0 |
| `deepseek/deepseek-v3.2` | 0 | 0 | 0 | 0 | 2 | 0 |
| `google/gemini-3.8-flash` | 0 | 0 | 0 | 0 | 4 | 0 |

Reading (facts only; the recommendation is CR-50-T06 below):

- On the small (#1) and the large (#3) pull request most models find nearly everything in every run. The medium
  pull request (#2) is the one that separates the models. Sonnet finds 8 of 12 (+1 borderline) and
  DeepSeek V4.1 Flash 8 of 12, Haiku and Opus 6 of 12 (+2), GPT-5.4 mini 4 of 12 (+2), DeepSeek V3.2 and Gemini 0 of 12.
- **#2 A, #2 B and #2 C are found by very different models.** #2 A: DeepSeek V4.1 Flash and GPT-5.4 mini 4 of 4,
  Haiku and Sonnet 2 of 4, Opus 0 of 4. #2 B: only Sonnet finds it in all 4 runs. #2 C: DeepSeek V4.1 Flash and Opus 4 of 4,
  Sonnet and Haiku 2 of 4, GPT-5.4 mini 0 of 4.
- DeepSeek V4.1 Flash is first on the medium pull request together with Sonnet, and total 23 of 28 against 24 for
  Sonnet, at 0.0037 USD against 0.0552 USD average cost (see "Results").
- False positives: 4 in total over 84 runs (Haiku 2, GPT-5.4 mini 2); all other models 0.
- Gemini finds nothing on the medium pull request in 4 runs; on the small pull request it misses one problem
  completely (#1 B, 0 of 4).
- Extra valid findings (true remarks beyond the planted problems) are counted separately and are not hits:
  Opus 8, Sonnet 6, Gemini 4, DeepSeek V4.1 Flash 3, Haiku 2, GPT-5.4 mini 2, DeepSeek V3.2 2. The text of these
  notes is not published (it would name unplanted findings of the playground).
- Cell size is 4 runs. Differences of one or two problems between neighbouring models in the totals are within the
  run-to-run spread, which this test shows directly: several models find a problem in 2 of 4 runs.

### Scoring criteria (neutral)

Fixed per pull request before scoring and applied in id order, followed by a consistency pass. The per-problem
criteria name the code under review and are kept with the private notes, like the list of planted problems; these
are the general rules:

- **found:** a finding whose subject is the problem and that names the failure case or consequence at the right
  code location. Hedged wording ("if X can happen, this fails") still counts when the failure case is named.
- **borderline:** the problem appears only as a sentence inside a finding about something else; or the finding is
  vague but points at the right place and consequence; or it addresses an adjacent aspect of the same code
  without naming the core failure.
- **missed:** not mentioned.
- A separate finding that says a weak test hides the problem counts as found only if it names the problem itself;
  standalone remarks about a weak test are recorded as extra valid findings.
- **false positive:** a finding that claims a defect that does not exist in the diff (contradicted by the code in
  the diff or by language or runtime behaviour). Style suggestions, speculation flagged as uncertain and true but
  unplanted findings are not false positives. True but unplanted findings are counted as **extra valid**.
  Design remarks that describe real behaviour accurately and claim no defect are counted in neither column.
- Findings that restate the same problem in several places count once.

## Comparison with CR-44 and CR-48

Earlier numbers (CR-44, CR-48): found out of 14 in the two required runs (small 4, medium 6, large 4), medium also
out of 15 over five runs. DeepSeek V4.1 Flash had no medium result.

| Model | CR-44/48 total (of 14) | CR-44/48 medium (of 15) | CR-50 total (of 28) | CR-50 medium (of 12) |
|---|---|---|---|---|
| `anthropic/claude-sonnet-5.5` | 13 | 13 | 24 | 8 |
| `deepseek/deepseek-v4.1-flash` | 8 (of 8, no medium) | not scorable | 23 | 8 |
| `anthropic/claude-opus-5.5` | 12 | 11 | 22 | 6 |
| `anthropic/claude-haiku-5.5` | 11 | 9 | 22 | 6 |
| `openai/gpt-5.4-mini` | 10 | 6 | 18 | 4 |
| `deepseek/deepseek-v3.2` | 8 | 4 | 14 | 0 |
| `google/gemini-3.8-flash` | 6 | 1 | 12 | 0 |

The order of the models is almost the same, but the medium pull request scores are lower in this fair run for
Sonnet (8 of 12 against 13 of 15), Opus, Haiku and DeepSeek V3.2 (0 against 4 of 15). Why the numbers differ:

1. **Shared comment state.** In CR-44 and CR-48 all runs of a pull request edited one persistent review comment.
   PR-Agent keeps the findings of earlier runs in that comment and reads them again, so every later run started
   from the accumulated state of the runs before it (on #2 up to 93 findings, which finally filled GitHub's comment
   limit and made the five DeepSeek V4.1 Flash runs of CR-48 unscorable). What a run found, and what
   the scorer saw in the comment, could therefore depend on which models ran before it. Here
   every run is a first review, with no earlier state, so each cell measures only that model.
2. **Order and number of runs.** CR-44/48 ran models in a fixed order; here the order is random per round. The cells
   have 4 runs for every model, not 2 (5 on the medium pull request).
3. **A different scorer and stricter written criteria.** CR-44/48 were scored manually by the developer who ran the
   tests (not blind); CR-50 was scored blind with criteria fixed in advance (a problem counts as found
   only with its failure case named at the right place). Some earlier "found" calls may be "borderline" under these criteria.
4. **Diff size for the Claude models on #3** is larger than in CR-44 (see "Observations"), a smaller effect.

We cannot separate these causes with the data we have, and we do not claim that the shared state alone explains
the gap. The fair run is the one to trust for ranking the models; the earlier tables are the ones to keep only as
history. The medium pull request lowered the scores of the models that earlier found most there, which fits an
earlier advantage from carried-over findings, but this is an interpretation and was not tested.

## Failures (CR-50-T03)

- **Model failures: none.** 84 of 84 counted runs ended with `ok: true` and a review comment. No
  `llm_output_invalid`, no timeout, no "Persistent review state did not fit" warning (searched in the runner output
  of all 86 runs), and no comment above 7,099 characters (the limit PR-Agent publishes is 65,000). DeepSeek V4.1
  Flash, which hit the limit in CR-48 because of 93 accumulated findings, produced normal comments (2,592 to 6,972
  characters) when it starts from an empty comment.
- **Two paid or planned runs were lost to a network outage on the developer machine** at about 20:31 local time
  (TLS handshake timeouts to `api.github.com`), not to a model:
  1. `anthropic/claude-sonnet-5.5`, #3, round 3: the runner returned `ok: false`, `errorCode: git_unavailable`
     ("Failed to get git provider"), 0 tokens, cost 0. Counted as a failure of the environment, not of the model,
     and repeated as run "3b" right after the plan (0.1200 USD, normal).
  2. `google/gemini-3.8-flash`, #3, round 3: the review ran (`ok: true`, 0.0521 USD), but reading the comment text
     afterwards failed ("the comment text was not saved (URLError)"), and the comment was deleted before the next
     run on #3, so the text is gone. The run is not counted (nothing to score) and was repeated as run "3b"
     (0.0520 USD). Both cells have exactly 4 counted runs.
  The driver was then hardened with retries for the GitHub calls before a run (the same outage had stopped the
  driver once earlier, between two runs, before any paid call; nothing was lost). The runs "3b" use the same
  settings and the same start state as the others.
- Runner note: `ok: true` from the runner does not guarantee that the comment text can be read later; the
  repeat above is a reminder that a run with a lost result is paid but useless.

## Observations (cost and speed)

- Order of cost per large review: Opus 0.24 USD, Sonnet 0.12 USD, Gemini 0.05, GPT-5.4 mini 0.03, DeepSeek V3.2
  0.012, Haiku 0.006, DeepSeek V4.1 Flash 0.003. Only the two Anthropic models above Haiku exceed the customer's
  0.10 USD per review on the large pull request.
- Slowest: DeepSeek V3.2 (129 s average, up to 212 s) and DeepSeek V4.1 Flash (63 s average, up to 256 s when it
  wrote 5.5k to 12k tokens). Fastest: Haiku and Sonnet (22 s average).
- Since all models now get the whole diff of #3 (37k PR-Agent tokens), the costs of the large pull request are
  higher than in CR-44 for Claude (54.7k input tokens, as already seen in CR-48 for Opus); CR-44's 45.0k came from
  an older cut of the diff.
- The recommendation (CR-50-T06) is pending the customer decision.

## Test cases

| Case | Result |
|---|---|
| CR-50-T01 | Section "Model ids and prices" and "Pilot and plan": all seven ids exist once, prices listed, pilot run, projection 3.32 USD with 15 percent margin (limit 4.25 for 4 runs). |
| CR-50-T02 | Every run has a `precheck.json` (comments before, bot comments deleted, comments after, bot comments after = 0); 86 of 86 show 0 bot comments after the deletion and before the run. Summary in "Method" and in the appendix columns. |
| CR-50-T03 | "Settings" table (identical), 4 counted runs in each of the 21 cells, order mixed per round with seed 980016226; failures in "Failures". |
| CR-50-T04 | Anonymous comments (84) and `index.csv`; scored by a separate blind scorer without model names, the mapping applied afterwards (section "Hit rates"). |
| CR-50-T05 | Total 2.9075 USD (limit 5.00), per model and in total in "Results", confirmed by OpenRouter's key counter. |
| CR-50-T06 | Pending customer decision. |
| CR-50-T07 | This report names the problems only as #1 A/B, #2 A/B/C and #3 A/B. |

## Commands

```
set -a; . ~/.config/code-reviewer/dev.env; set +a        # the developer's credentials, never printed
cd runner
.venv/bin/python ../docs/spike/data/cr-50/fair_runs.py plan --seed 980016226 --rounds 4
.venv/bin/python ../docs/spike/data/cr-50/fair_runs.py run --model anthropic/claude-haiku-5.5 --pr 3 --round 1 \
  --out /path/to/out --blind /path/to/blind --mapping /path/to/mapping.csv
```

`run` deletes the bot's comments on the pull request, checks that none is left, runs `manual_review.py` with
`--record-dir`, and writes the anonymous copy and the mapping row. The records stay outside the repository.

## Appendix: every counted run

Comment chars is the length of the comment text of the run. The last two columns come from the check before the
run: bot comments deleted, and bot comments left after the deletion (always 0). The Gemini and Sonnet runs of round
3 on #3 in this table are the repeats ("3b"). The anonymous ids are intentionally not listed here.

| Model | PR | Run | Result | Error code | Duration (s) | Tokens in / out | Cost (USD) | Comment chars | Bot comments deleted before | Bot comments after delete |
|---|---|---|---|---|---|---|---|---|---|---|
| `anthropic/claude-haiku-5.5` | 1 | 1 | ok | - | 14 | 4546 / 884 | 0.0009 | 3016 | 1 | 0 |
| `anthropic/claude-haiku-5.5` | 1 | 2 | ok | - | 12 | 4546 / 403 | 0.0007 | 3152 | 1 | 0 |
| `anthropic/claude-haiku-5.5` | 1 | 3 | ok | - | 14 | 4546 / 741 | 0.0008 | 2836 | 1 | 0 |
| `anthropic/claude-haiku-5.5` | 1 | 4 | ok | - | 14 | 4546 / 897 | 0.0009 | 2932 | 1 | 0 |
| `anthropic/claude-haiku-5.5` | 2 | 1 | ok | - | 18 | 11886 / 677 | 0.0015 | 5556 | 1 | 0 |
| `anthropic/claude-haiku-5.5` | 2 | 2 | ok | - | 22 | 11886 / 2012 | 0.0022 | 3378 | 1 | 0 |
| `anthropic/claude-haiku-5.5` | 2 | 3 | ok | - | 22 | 11886 / 1969 | 0.0022 | 5563 | 1 | 0 |
| `anthropic/claude-haiku-5.5` | 2 | 4 | ok | - | 24 | 11886 / 2251 | 0.0023 | 5001 | 1 | 0 |
| `anthropic/claude-haiku-5.5` | 3 | 1 | ok | - | 37 | 54687 / 1510 | 0.0062 | 4885 | 1 | 0 |
| `anthropic/claude-haiku-5.5` | 3 | 2 | ok | - | 27 | 54687 / 758 | 0.0058 | 5353 | 1 | 0 |
| `anthropic/claude-haiku-5.5` | 3 | 3 | ok | - | 31 | 54687 / 1749 | 0.0063 | 5283 | 1 | 0 |
| `anthropic/claude-haiku-5.5` | 3 | 4 | ok | - | 32 | 54687 / 1615 | 0.0063 | 3871 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 1 | 1 | ok | - | 16 | 4546 / 560 | 0.0147 | 4192 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 1 | 2 | ok | - | 14 | 4546 / 558 | 0.0147 | 4258 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 1 | 3 | ok | - | 13 | 4546 / 434 | 0.0134 | 3216 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 1 | 4 | ok | - | 13 | 4546 / 597 | 0.0151 | 4456 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 2 | 1 | ok | - | 23 | 11886 / 839 | 0.0322 | 6456 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 2 | 2 | ok | - | 19 | 11886 / 782 | 0.0316 | 5747 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 2 | 3 | ok | - | 20 | 11886 / 774 | 0.0315 | 5855 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 2 | 4 | ok | - | 20 | 11886 / 808 | 0.0319 | 6405 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 3 | 1 | ok | - | 31 | 54687 / 893 | 0.1183 | 3599 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 3 | 2 | ok | - | 33 | 54687 / 1029 | 0.1197 | 3855 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 3 | 3 | ok | - | 31 | 54687 / 1058 | 0.1200 | 3861 | 1 | 0 |
| `anthropic/claude-sonnet-5.5` | 3 | 4 | ok | - | 31 | 54687 / 1030 | 0.1197 | 4009 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 1 | 1 | ok | - | 15 | 4546 / 515 | 0.0285 | 4053 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 1 | 2 | ok | - | 17 | 4546 / 546 | 0.0291 | 4284 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 1 | 3 | ok | - | 17 | 4546 / 557 | 0.0293 | 4535 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 1 | 4 | ok | - | 15 | 4546 / 525 | 0.0287 | 4297 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 2 | 1 | ok | - | 32 | 11886 / 1606 | 0.0797 | 6475 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 2 | 2 | ok | - | 31 | 11886 / 1750 | 0.0825 | 5430 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 2 | 3 | ok | - | 30 | 11886 / 1550 | 0.0785 | 5472 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 2 | 4 | ok | - | 31 | 11886 / 1790 | 0.0833 | 7072 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 3 | 1 | ok | - | 36 | 54687 / 1169 | 0.2421 | 5423 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 3 | 2 | ok | - | 35 | 54687 / 1197 | 0.2427 | 5288 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 3 | 3 | ok | - | 32 | 54687 / 941 | 0.2376 | 4255 | 1 | 0 |
| `anthropic/claude-opus-5.5` | 3 | 4 | ok | - | 34 | 54687 / 1196 | 0.2427 | 5415 | 1 | 0 |
| `openai/gpt-5.4-mini` | 1 | 1 | ok | - | 16 | 2918 / 500 | 0.0044 | 2031 | 4 | 0 |
| `openai/gpt-5.4-mini` | 1 | 2 | ok | - | 20 | 2918 / 527 | 0.0027 | 2067 | 1 | 0 |
| `openai/gpt-5.4-mini` | 1 | 3 | ok | - | 15 | 2918 / 528 | 0.0046 | 3048 | 1 | 0 |
| `openai/gpt-5.4-mini` | 1 | 4 | ok | - | 16 | 2918 / 732 | 0.0055 | 2930 | 1 | 0 |
| `openai/gpt-5.4-mini` | 2 | 1 | ok | - | 32 | 7427 / 2175 | 0.0154 | 2404 | 1 | 0 |
| `openai/gpt-5.4-mini` | 2 | 2 | ok | - | 50 | 7427 / 4714 | 0.0268 | 3998 | 1 | 0 |
| `openai/gpt-5.4-mini` | 2 | 3 | ok | - | 38 | 7427 / 3491 | 0.0166 | 5946 | 1 | 0 |
| `openai/gpt-5.4-mini` | 2 | 4 | ok | - | 37 | 7427 / 3360 | 0.0207 | 3632 | 1 | 0 |
| `openai/gpt-5.4-mini` | 3 | 1 | ok | - | 34 | 37103 / 758 | 0.0312 | 2986 | 1 | 0 |
| `openai/gpt-5.4-mini` | 3 | 2 | ok | - | 32 | 37103 / 1161 | 0.0331 | 6819 | 1 | 0 |
| `openai/gpt-5.4-mini` | 3 | 3 | ok | - | 31 | 37103 / 771 | 0.0187 | 3080 | 0 | 0 |
| `openai/gpt-5.4-mini` | 3 | 4 | ok | - | 30 | 37103 / 770 | 0.0313 | 3160 | 1 | 0 |
| `google/gemini-3.8-flash` | 1 | 1 | ok | - | 27 | 3311 / 2603 | 0.0122 | 1967 | 1 | 0 |
| `google/gemini-3.8-flash` | 1 | 2 | ok | - | 18 | 3311 / 1464 | 0.0080 | 2007 | 1 | 0 |
| `google/gemini-3.8-flash` | 1 | 3 | ok | - | 16 | 3311 / 945 | 0.0060 | 1917 | 1 | 0 |
| `google/gemini-3.8-flash` | 1 | 4 | ok | - | 17 | 3311 / 1339 | 0.0075 | 1945 | 1 | 0 |
| `google/gemini-3.8-flash` | 2 | 1 | ok | - | 71 | 8834 / 10672 | 0.0466 | 2954 | 1 | 0 |
| `google/gemini-3.8-flash` | 2 | 2 | ok | - | 77 | 8834 / 12485 | 0.0534 | 2757 | 1 | 0 |
| `google/gemini-3.8-flash` | 2 | 3 | ok | - | 73 | 8834 / 11555 | 0.0500 | 2708 | 1 | 0 |
| `google/gemini-3.8-flash` | 2 | 4 | ok | - | 66 | 8834 / 10520 | 0.0461 | 2500 | 1 | 0 |
| `google/gemini-3.8-flash` | 3 | 1 | ok | - | 43 | 49864 / 2866 | 0.0481 | 3038 | 1 | 0 |
| `google/gemini-3.8-flash` | 3 | 2 | ok | - | 39 | 49864 / 2588 | 0.0471 | 3064 | 1 | 0 |
| `google/gemini-3.8-flash` | 3 | 3 | ok | - | 45 | 49864 / 3884 | 0.0520 | 3278 | 1 | 0 |
| `google/gemini-3.8-flash` | 3 | 4 | ok | - | 43 | 49864 / 3593 | 0.0509 | 3212 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 1 | 1 | ok | - | 63 | 3013 / 1202 | 0.0017 | 3101 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 1 | 2 | ok | - | 102 | 3013 / 1297 | 0.0018 | 3238 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 1 | 3 | ok | - | 212 | 3013 / 1895 | 0.0019 | 2858 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 1 | 4 | ok | - | 103 | 3013 / 2049 | 0.0024 | 3352 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 2 | 1 | ok | - | 205 | 7698 / 2241 | 0.0038 | 3612 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 2 | 2 | ok | - | 137 | 7701 / 3836 | 0.0035 | 2376 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 2 | 3 | ok | - | 132 | 7701 / 3350 | 0.0033 | 2982 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 2 | 4 | ok | - | 54 | 7698 / 2226 | 0.0031 | 2578 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 3 | 1 | ok | - | 109 | 48953 / 3242 | 0.0112 | 3444 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 3 | 2 | ok | - | 128 | 38320 / 2491 | 0.0109 | 3170 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 3 | 3 | ok | - | 212 | 38317 / 3900 | 0.0130 | 3038 | 1 | 0 |
| `deepseek/deepseek-v3.2` | 3 | 4 | ok | - | 85 | 38317 / 2657 | 0.0118 | 3340 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 1 | 1 | ok | - | 14 | 3039 / 808 | 0.0007 | 3644 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 1 | 2 | ok | - | 20 | 3039 / 684 | 0.0006 | 3868 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 1 | 3 | ok | - | 14 | 3039 / 546 | 0.0005 | 3788 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 1 | 4 | ok | - | 19 | 3039 / 743 | 0.0006 | 3652 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 2 | 1 | ok | - | 98 | 7724 / 20690 | 0.0137 | 6972 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 2 | 2 | ok | - | 49 | 7724 / 8862 | 0.0059 | 6464 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 2 | 3 | ok | - | 61 | 7724 / 8116 | 0.0054 | 6214 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 2 | 4 | ok | - | 55 | 7724 / 9916 | 0.0066 | 4641 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 3 | 1 | ok | - | 55 | 38343 / 3563 | 0.0021 | 4039 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 3 | 2 | ok | - | 59 | 38343 / 4982 | 0.0032 | 4020 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 3 | 3 | ok | - | 256 | 38343 / 5539 | 0.0020 | 2592 | 1 | 0 |
| `deepseek/deepseek-v4.1-flash` | 3 | 4 | ok | - | 49 | 38343 / 2085 | 0.0032 | 4142 | 1 | 0 |
