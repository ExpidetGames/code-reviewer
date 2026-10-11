// SPDX-License-Identifier: Apache-2.0

// Pins down which sender the running server gets: none, unless the test stack switches the file outbox on
// with both variables. A real deployment cannot configure mail through the environment.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mailSenderFor } from "./shared.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("the mail sender of the running server", () => {
  it("is not configured by default", async () => {
    expect(await mailSenderFor({}).isConfigured()).toBe(false);
  });

  // #99-SR-05
  it.each([
    { TEST_MAIL_OUTBOX_FILE: "/tmp/x.jsonl" },
    { ALLOW_TEST_MAIL_OUTBOX: "true" },
    { ALLOW_TEST_MAIL_OUTBOX: "1", TEST_MAIL_OUTBOX_FILE: "/tmp/x.jsonl" },
    { SMTP_HOST: "smtp.example.com", SMTP_USER: "u", SMTP_PASSWORD: "p" },
  ])(
    "ignores the environment %j (mail is never configured there)",
    async (env) => {
      expect(await mailSenderFor(env).isConfigured()).toBe(false);
    },
  );

  it("writes messages to the outbox file when the test stack switches it on", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbox-"));
    directories.push(directory);
    const file = join(directory, "outbox.jsonl");
    const sender = mailSenderFor({
      ALLOW_TEST_MAIL_OUTBOX: "true",
      TEST_MAIL_OUTBOX_FILE: file,
    });

    const result = await sender.send({
      to: "a@example.com",
      subject: "s",
      text: "t",
    });

    expect(await sender.isConfigured()).toBe(true);
    expect(result).toEqual({ ok: true });
    expect(JSON.parse((await readFile(file, "utf8")).trim())).toEqual({
      to: "a@example.com",
      subject: "s",
      text: "t",
    });
  });

  it("reports mail_failed when the outbox file cannot be written", async () => {
    const sender = mailSenderFor({
      ALLOW_TEST_MAIL_OUTBOX: "true",
      TEST_MAIL_OUTBOX_FILE: "/nonexistent-directory/outbox.jsonl",
    });

    expect(
      await sender.send({ to: "a@example.com", subject: "s", text: "t" }),
    ).toEqual({
      ok: false,
      error: "mail_failed",
    });
  });
});
