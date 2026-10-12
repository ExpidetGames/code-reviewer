# Mail

How the app sends mail. `MailSender` (`sender.ts`) is the interface everything goes through: the verification
link today, the password reset, the test mail and the invitations in the next issues. `isConfigured()` says
whether the instance can send mail at all (the sign-up rule, the verification gate and the admin portal ask it);
`send()` never throws, a failure is a code (`not_configured`, `mail_failed`) and nothing in it can carry the
message.

| File                      | Role                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sender.ts`               | The interface, the error codes and `notConfiguredMailSender`                                                                                                                                                                         |
| `shared.ts`               | `getMailSender()`, the sender of the running server, looked up on every call because the admin can add or remove the mail server at any time                                                                                         |
| `outbox-sender.ts`        | The test stack's stand-in for a mail server: appends each message as a line of JSON to a file. Switched on by `ALLOW_TEST_MAIL_OUTBOX=true` and `TEST_MAIL_OUTBOX_FILE`, which only the test stack sets                              |
| `verification-message.ts` | The verification mail and its link, built from the configured address of the app                                                                                                                                                     |
| `invitation-message.ts`   | The invitation mail and its link (`/invitation?token=...`), built from the configured address; the workspace name and the name of the person who invites are made one line (no new header, no new paragraph) and escaped in the HTML |

Mail is never configured through environment variables. Until the SMTP settings issue, the running server has
no mail server: it returns `notConfiguredMailSender`, so a sign-up rule that names emails or domains stays
closed and accounts are usable unverified. That issue replaces the body of `getMailSender()` with the SMTP
sender built from the settings and the encrypted password in the secret store; nothing else changes. Tests use
the double in `src/test-support/fake-mail.ts`: an outbox, a switch between "mail server" and "none", and a
failure on demand.
