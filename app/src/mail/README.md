# Mail

How the app sends mail, and where the admin sets the mail server up. The decision is in
`docs/decisions/0001-editions-setup-and-accounts.md`, sections 2.3, 2.5 and 2.7; the page is `/admin/mail`.

`MailSender` (`sender.ts`) is the interface everything goes through: the verification link, the password reset, the
test mail and (in the workspaces issue) the invitations. `isConfigured()` says whether the instance can send mail at
all (the sign-up rule, the verification gate, the reset page and the admin portal ask it). It means "a message could be sent now": valid settings and, when there is a login, a password that is there and can be read. Saved settings whose password is missing or cannot be read count as no mail server until the password is entered again (the portal shows the settings and says what is wrong; the test mail still works on saved settings and names the problem); `send()` never throws, a
failure is a code (`not_configured`, `mail_failed`) and nothing in it can carry the message.

| File                                                   | Role                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sender.ts`                                            | The interface, the error codes and `notConfiguredMailSender`                                                                                                                                                                         |
| `shared.ts`                                            | `getMailSender()` and `getSmtpConfigStore()`, looked up on every call because the admin can add, change or remove the mail server at any time                                                                                        |
| `smtp-settings.ts`                                     | The settings (host, port, security, user, sender address and name, "allow self-signed") and their validation, a stable code per field                                                                                                |
| `smtp-config.ts`                                       | Stores them: the settings in `instance_settings` (key `smtp`), the password in the secret store (`smtp_password`); `view` for the portal (never a password), `resolve` for the sender                                                |
| `smtp-delivery.ts`                                     | One delivery with nodemailer: security modes, certificate check, time limits, the rules for what goes into a header                                                                                                                  |
| `smtp-failure.ts`                                      | Sorts a mail library error into a stable class (`dns_failure`, `connection_refused`, `tls_error`, `auth_failed`, `sender_rejected`, `recipient_rejected`, `timeout`, ...) with a sentence that is safe to show                       |
| `smtp-sender.ts`                                       | The SMTP implementation of `MailSender`                                                                                                                                                                                              |
| `test-mail.ts`                                         | The "send test mail" button: the message, and the limit per admin and for the instance                                                                                                                                               |
| `verification-message.ts`, `password-reset-message.ts` | The mails that carry a verification link and a reset link. Both link to the configured public address of the app, never to a request header                                                                                          |
| `invitation-message.ts`                                | The invitation mail and its link (`/invitation?token=...`), built from the configured address; the workspace name and the name of the person who invites are made one line (no new header, no new paragraph) and escaped in the HTML |

## Mail is configured in the portal only

Nothing in the app reads an `SMTP_*` variable (`shared.test.ts` fails when a source file names one). The settings are
rows in the database; the password is encrypted with a key derived from `APP_SECRET` and is **write-only**: the page
shows whether one is saved, an empty password field keeps it, the checkbox removes it, and no API returns it, no log
line has it, and no error carries it. A password that cannot be decrypted (another `APP_SECRET`) is a state of its own:
the page asks for it again, the overview says that no mail can be sent, nothing that needs mail is offered
meanwhile (confirming addresses, "Forgot your password?"), and every send fails with `mail_failed` until it is entered
again.

**The saved password stays with the server it was entered for.** An empty password field keeps it only while host, port,
user and security are unchanged; otherwise the save is refused (`password_required_for_new_server`) and the password has
to be entered again. Without that, a stolen admin session could point the host at a server of its own and have "Send test
mail" hand over the stored password. The settings row and the password are saved, cleared and removed in one transaction.

## What the app does with the host the admin enters

- **It connects to that host from its own network**, on that port. The admin is trusted, but the app is the one that
  connects, so enter only a mail server you trust, and know that a host on the internal network of the deployment is
  reachable from here. The port is 25, 465 or 587, or any port from 1024 up; the other ports below 1024 are refused so
  the mail client cannot be pointed at ssh, http, imap and the like.
- **Security.** `starttls` demands the upgrade: a server that does not offer STARTTLS is a `tls_error`, and neither the
  login nor the message is ever sent in the clear. `tls` is TLS from the first byte. `none` is plain on purpose, does not
  even try STARTTLS, and the page shows a warning. A **login** over `none` sends the user name and the password in the
  clear, so the settings are only accepted with an explicit confirmation (`allowPlainTextLogin`, which the form sets after
  a second warning box is ticked; the server refuses without it, and the delivery refuses to log in without it). TLS 1.2 or newer.
- **Certificates are verified** (chain and host name) unless the admin ticks "Accept a self-signed certificate", which
  turns the verification off completely and comes with a warning on the page. It is always off without encryption.
- **Time limits**: 10 s to connect, 10 s for the greeting, 20 s for a silent socket, 30 s for the whole delivery. One
  attempt: no queue, no retry (a failed mail is a `mail_failed` and the caller carries on). At the 30 s limit the socket
  is destroyed (the delivery uses a socket of its own for that: closing a transport does not close a send in progress), so
  a server that answers one byte at a time cannot accept the message after the caller was told `timeout`.
- **Headers.** The recipient is checked against an allow list before anything is opened (printable ASCII: letters, digits
  and the punctuation of an unquoted address, no white space, control character of any range, comma, quote, angle bracket
  or second `@`), the envelope is built from exactly the addresses we mean, the
  subject loses its control characters (a CR or LF becomes a space), the sender name loses them too, and the library
  encodes the rest. `smtp-delivery.integration.test.ts` reads the bytes the fake server received and looks for an
  injected header.

## The test mail

`POST /api/admin/mail/test` sends one message to the admin's own address with the **saved** settings and answers `{ "ok":
true }` or `{ "ok": false, "error": <class>, "detail": ... }`. The detail is a sentence of ours (a certificate problem)
or the first line of the server's reply, cleaned: printable ASCII, 200 characters, the password removed in every
spelling (plain, base64, hex, URL encoded), long opaque tokens replaced. It is limited to 5 per admin and 20 for the
instance in 10 minutes (`rate_limits`), counted when there is a mail server to try, and a counter that cannot be read
refuses the click.

## Tests

`smtp-settings.test.ts`, `smtp-failure.test.ts`, `password-reset-message.test.ts`: the pure logic.
`smtp-delivery.integration.test.ts`, `smtp-sender.integration.test.ts`, `test-mail.integration.test.ts`,
`smtp-config.integration.test.ts`: the real protocol against the fake SMTP server (`fakes/smtp`, started in the test by
`src/test-support/smtp-fake.ts`), a real SQLite file and the real secret store. Callers that only need "a mail was
sent" (the sign-up) use the double in `src/test-support/fake-mail.ts`: an outbox, a switch between "mail server" and
"none", and a failure on demand. The browser journeys use the fake SMTP server too.
