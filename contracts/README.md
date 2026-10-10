# Contracts

Machine-readable descriptions of the interfaces that two parts of the system share. A contract file
is the single source of its format: the code on both sides is checked against the file, never the
other way round, so a change to the format has to change the file and both sides.

| File                         | What                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner-api.v1.json`         | The wire format of the runner API v1 (JSON Schema, draft 2020-12): the claim response, the heartbeat and complete requests and responses, and every error. The `$defs` are the named bodies. |
| `examples/<Definition>.json` | One valid document per body. Both test suites validate them, so an example can never drift from the schema. They hold dummy values only.                                                     |

## Who checks what

- **App** (`app/integration-tests/compatibility/runner-api-contract.integration.test.ts`, with Ajv):
  the real answers of the routes are valid against the file; the hand-written checks on what a runner
  sends give the same verdict as the file for a set of good and bad bodies; the lists the app keeps
  in TypeScript (`app/src/runner-api/contract.ts`: error codes, commands) equal the lists in the file.
- **Runner** (`runner/tests/contract/test_runner_api_contract.py`, with `jsonschema`): the examples are
  valid, and the rules the runner relies on hold (the job input is closed, because the runner refuses
  unknown fields; an ask job has exactly its question; the error code rules of a result).

## Rules of version 1

- The version is in the path (`/api/runners/v1/...`) and in every response body (`"version": 1`).
  A change that breaks a reader makes a version 2 with its own file; this file only grows in ways
  readers may ignore.
- A reader ignores fields it does not know. The one exception is `RunnerJobInput` (the job the runner
  reads on stdin), which is closed because the runner refuses unknown fields.
- Callers branch on error codes, never on messages. The codes the runner reports are listed in
  `KnownRunnerErrorCode`; the app accepts any code of the right form and stores one it does not know as
  `unknown` (the original stays in the stored result).
- Secrets (`git.token`, `llm.apiKey`, `leaseToken`) appear in the claim response and in requests that
  prove a claim, and nowhere else.

The meaning of the calls (status codes, the lease, what happens on failure) is in
`app/src/runner-api/README.md`.
