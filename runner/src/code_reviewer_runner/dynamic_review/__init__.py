# SPDX-License-Identifier: Apache-2.0

"""Dynamic Review preparation and prompt assets; no engine launch or capability activation.

`checkout.py` prepares a bounded read-only pull request export. `prompt_core.py` owns the fixed,
code-owned core (read-only rules, untrusted-data rules, output format, re-review rules);
`prompts.py` composes it with the editable, lower-priority review skill from a claim and
demarcates the untrusted pull request input. `dynamic_findings.py` validates the model's answer
against the contract. The engine that calls the model is #197's.
"""
