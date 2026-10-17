Closes #<!-- issue number -->

## Summary

<!-- What changed and why, in a few sentences. Keep the pull request to one issue. -->

## How it was tested

<!--
The failing tests you wrote first, at which level (see TESTING.md), and the commands you ran,
for example `make verify`, `make test-engine`, `make test-e2e`, `make test-images`.
If no automated test applies, say why (for example a purely visual change or documentation).
-->

## Test cases

<!--
Optional for contributors, expected from maintainers. If the issue has a "Test cases" table, map each
case to the test that proves it, or say why it is manual or not applicable. Delete this section if the
issue has no such table.
-->

| Test case | Test file / name | Status |
| --- | --- | --- |
|  |  |  |

## Checklist

- [ ] The change is linked to an issue above (`Closes #n`) and the pull request goes into `development`.
- [ ] Tests were written first and are included (a bug fix has a test that was red before the fix).
- [ ] `make verify` is green.
- [ ] Documentation is updated where the change needs it (README, `docs/`, `TESTING.md`, `.env.example`).
- [ ] A new database migration only adds (a removal waits one release): the deployment migrates before it stages anything, so the live version must still work on the new schema (`docs/deployment-vercel.md`, section 5.6).
- [ ] No secrets: no keys, tokens, private keys, `.env` files or real credentials in the code, the tests, the logs or this description.

## Follow-ups

<!-- Things you noticed but did not do here. Open an issue for each one, or write "none". -->
