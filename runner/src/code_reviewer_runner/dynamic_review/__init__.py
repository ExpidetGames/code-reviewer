# SPDX-License-Identifier: Apache-2.0

"""Dynamic Review prompt assets, composition and publication (#198, #199).

`prompt_core.py` owns the fixed, code-owned core (read-only rules, untrusted-data rules, output
format, re-review rules); `prompts.py` composes it with the editable, lower-priority review skill
from a claim and demarcates the untrusted pull request input. `dynamic_findings.py` validates the
model's answer against the contract.

`state.py`, `reconcile.py`, `render.py`, `github.py` and `publish.py` own the persistent summary
comment: the validated state that survives a push, the reconciliation of a run with it, the rendered
view plus hidden state, the narrow GitHub client and the publisher that keeps exactly one bot-owned
comment. The engine that calls the model is #197's.
"""
