# SPDX-License-Identifier: LicenseRef-Proprietary

"""The timing of a run that a newer push superseded (#396, #397), in one place.

The app (`app/src/jobs/supersede-timing.ts`) and this runner state the same numbers, and the
contract file states them once more (`SupersedeTiming` in `contracts/runner-api.v1.json`); a test
on each side compares its constants with the contract.

```
push --(next heartbeat, at most 60 s)--> the host knows and tells the process
     --(the requests in flight finish, each within 120 s)--> the result is reported
```

A model request may start up to the moment the process is told, and it takes at most
`LONGEST_MODEL_REQUEST_SECONDS` (PR-Agent's `ai_timeout`, the model proxy's timeout). So the app
keeps the claim for the heartbeat, the longest request and a margin (`CLAIM_SECONDS`, 240), and the
host drains for the longest request but never past the lease its heartbeat answer named, less
`KILL_MARGIN_SECONDS`, so that the report always arrives while the claim holds.
"""

# The longest heartbeat interval a Worker or runner uses (`MAX_HEARTBEAT_INTERVAL_SECONDS` of the
# API client).
MAX_HEARTBEAT_INTERVAL_SECONDS = 60
# PR-Agent's `config.ai_timeout` and the model proxy's timeout of a request. A test pins both here.
LONGEST_MODEL_REQUEST_SECONDS = 120
# How long the host waits for a process that was told, at most: the longest request.
SUPERSEDED_DRAIN_SECONDS = 120.0
# The host ends the process this long before the claim ends, whatever the drain says: the end (the
# SIGTERM grace) and the report have to fit in the claim.
KILL_MARGIN_SECONDS = 20.0
# What the app keeps the claim for, and how long it takes a late report (the sweep settles after
# both).
CLAIM_SECONDS = 240
REPORT_GRACE_SECONDS = 60
