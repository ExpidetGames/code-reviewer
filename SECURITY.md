# Security policy

code-review.com reads pull requests, talks to GitHub as a GitHub App and passes code to a language
model. Vulnerabilities in how it handles credentials, webhooks, sign in or repository access matter
to us, and we are grateful for reports that follow this policy.

## Supported versions

The project is still in development and has no stable release yet. Until it has one, only the
current state of the `main` branch (and the images published from it) receives security fixes.

Once releases exist, this table will list them. The rule will be: the latest release gets fixes,
older releases do not.

| Version | Supported |
|---|---|
| `main` (latest) | yes |
| anything else | no |

## Reporting a vulnerability

Do not open a public issue, pull request or discussion for a security problem, and do not post
details anywhere public before we have fixed it.

Report it privately with GitHub's private vulnerability reporting:

1. Open [https://github.com/ExpidetGames/code-reviewer/security/advisories/new](https://github.com/ExpidetGames/code-reviewer/security/advisories/new)
   (the "Report a vulnerability" button on the Security tab of the repository).
2. Describe the problem: what is affected, the steps to reproduce it, and what an attacker gains.
   A short proof of concept helps.
3. Name the version or commit you tested.

Only the maintainers can see the report. We will use the same private advisory to talk to you, to
work on the fix and, if it is warranted, to publish a security advisory with a CVE.

Never include real credentials in a report: no API keys, tokens, private keys or webhook secrets.
If your finding needs one to be demonstrated, use a throwaway value. If you found a real secret
that belongs to someone else, say so in the report, do not use it, and do not keep a copy.

## What to expect

- We confirm that we received your report within 3 working days.
- We give you a first assessment (accepted, needs more information, or not a vulnerability) within
  10 working days.
- We keep you informed about progress, and we aim to ship a fix for confirmed issues within 90 days
  of the report. Critical issues are handled first.
- With your agreement we credit you in the advisory.

## Disclosure

We follow coordinated disclosure. We ask you to keep the details private until a fix is available
or 90 days have passed since the report, whichever comes first. If we need more time, we will
agree a new date with you. When the fix is released we publish a GitHub security advisory that
describes the problem, the affected versions and the fix.

## Scope

In scope: the code in this repository, the published container images, and the default
configuration in `compose.yml`.

Out of scope: vulnerabilities in third party software that we only depend on (report those
upstream, for example to the [PR-Agent](https://github.com/qodo-ai/pr-agent) project), missing
hardening in a deployment that you run yourself, and findings that need a maintainer account or
physical access to the machine.

For problems that are not security related, use the normal [issue forms](https://github.com/ExpidetGames/code-reviewer/issues/new/choose).
