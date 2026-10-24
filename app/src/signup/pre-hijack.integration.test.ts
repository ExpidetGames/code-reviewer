// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that nobody can take over an account by signing up with another person's address first. Two
// people sign up with one address (the attacker's mail goes to the owner's inbox, like the owner's own),
// and the owner clicks the links in either order. A link is used with the password of the sign-up that
// made it, so the owner can only complete their own sign-up; the account's password is never replaced by a
// repeat sign-up, and what the owner completes is the password that counts afterwards.
import { describe, expect, it } from "vitest";
import {
  createSignUpHarness,
  SIGNUP_TEST_PASSWORD,
  type SignUpHarness,
} from "../test-support/signup-harness.ts";

const ADDRESS = "victim@example.com";
const ATTACKER_PASSWORD = "attacker-chosen-pw-4417";
const VICTIM_PASSWORD = SIGNUP_TEST_PASSWORD;

async function signUpTwice(
  harness: SignUpHarness,
  first: string,
  second: string,
) {
  const links: string[] = [];
  for (const password of [first, second]) {
    await harness.signUp({ email: ADDRESS, password });
    await harness.flush();
    links.push(harness.mail.lastToken(ADDRESS));
  }
  return { first: links[0] ?? "", second: links[1] ?? "" };
}

async function canSignIn(harness: SignUpHarness, password: string) {
  return harness.auth.api
    .signInEmail({ body: { email: ADDRESS, password } })
    .then(
      () => true,
      () => false,
    );
}

describe("an attacker who signs up with the address of another person first", () => {
  // #99-SR-12
  it("cannot be completed by the owner who clicks the attacker's link first, and the owner's own link still works", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const { first: attackers, second: owners } = await signUpTwice(
      harness,
      ATTACKER_PASSWORD,
      VICTIM_PASSWORD,
    );

    const clickedFirst = await harness.verify({
      token: attackers,
      password: VICTIM_PASSWORD,
    });
    const noPassword = await harness.verify({ token: attackers });
    const stillUnverified = (await harness.user(ADDRESS))?.email_verified;
    const completed = await harness.verify({
      token: owners,
      password: VICTIM_PASSWORD,
    });

    expect(clickedFirst.status).toBe(400);
    expect(await clickedFirst.json()).toEqual({ error: "invalid_token" });
    expect(noPassword.status).toBe(400);
    expect(stillUnverified).toBe(0);
    expect(completed.status).toBe(200);
    expect((await harness.user(ADDRESS))?.email_verified).toBe(1);
    expect(await canSignIn(harness, VICTIM_PASSWORD)).toBe(true);
    expect(await canSignIn(harness, ATTACKER_PASSWORD)).toBe(false);
  });

  // #99-SR-12
  it("cannot get in either when the owner clicks their own link first, and the attacker's link is dead afterwards", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const { first: attackers, second: owners } = await signUpTwice(
      harness,
      ATTACKER_PASSWORD,
      VICTIM_PASSWORD,
    );

    const completed = await harness.verify({
      token: owners,
      password: VICTIM_PASSWORD,
    });
    const late = await harness.verify({
      token: attackers,
      password: ATTACKER_PASSWORD,
    });

    expect(completed.status).toBe(200);
    expect(late.status).toBe(400);
    expect(await late.json()).toEqual({ error: "invalid_token" });
    expect(await canSignIn(harness, VICTIM_PASSWORD)).toBe(true);
    expect(await canSignIn(harness, ATTACKER_PASSWORD)).toBe(false);
  });

  // #99-SR-12
  it("does not keep the password they chose when the owner completes a sign-up of their own: it is replaced, and sessions it opened end", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await harness.signUp({ email: ADDRESS, password: ATTACKER_PASSWORD });
    await harness.flush();
    // The instance had no mail server when the attacker signed in; now it has.
    harness.mail.configured = false;
    await harness.auth.api.signInEmail({
      body: { email: ADDRESS, password: ATTACKER_PASSWORD },
    });
    harness.mail.configured = true;
    await harness.signUp({ email: ADDRESS, password: VICTIM_PASSWORD });
    await harness.flush();

    await harness.verify({
      token: harness.mail.lastToken(ADDRESS),
      password: VICTIM_PASSWORD,
    });

    const sessions = await harness.db
      .selectFrom("sessions")
      .select("user_id")
      .where("user_id", "=", (await harness.user(ADDRESS))?.id ?? "")
      .execute();
    expect(sessions).toEqual([]);
    expect(await canSignIn(harness, ATTACKER_PASSWORD)).toBe(false);
  });
});

describe("an attacker who signs up with the address of a person who signed up before", () => {
  // #99-SR-12
  it("leaves the password of the owner's account alone, and the owner completes their own link whichever they click first", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const { first: owners, second: attackers } = await signUpTwice(
      harness,
      VICTIM_PASSWORD,
      ATTACKER_PASSWORD,
    );

    const wrong = await harness.verify({
      token: attackers,
      password: VICTIM_PASSWORD,
    });
    const completed = await harness.verify({
      token: owners,
      password: VICTIM_PASSWORD,
    });

    expect(wrong.status).toBe(400);
    expect(completed.status).toBe(200);
    expect(await canSignIn(harness, VICTIM_PASSWORD)).toBe(true);
    expect(await canSignIn(harness, ATTACKER_PASSWORD)).toBe(false);
  });

  // #99-SR-12
  it("cannot keep the owner's link from working by signing up again", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await harness.signUp({ email: ADDRESS, password: VICTIM_PASSWORD });
    await harness.flush();
    const owners = harness.mail.lastToken(ADDRESS);

    await harness.signUp({ email: ADDRESS, password: ATTACKER_PASSWORD });
    await harness.signUp({ email: ADDRESS, password: ATTACKER_PASSWORD });
    await harness.resend({ email: ADDRESS });
    await harness.flush();

    expect(
      (await harness.verify({ token: owners, password: VICTIM_PASSWORD }))
        .status,
    ).toBe(200);
  });
});

describe("the password on the verification page", () => {
  // #99-SR-12
  it("is answered exactly like an unknown token when it is wrong, so nothing says which part was wrong", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await harness.signUp({ email: ADDRESS, password: VICTIM_PASSWORD });
    await harness.flush();
    const token = harness.mail.lastToken(ADDRESS);
    const read = async (response: Response) => ({
      status: response.status,
      body: await response.json(),
      retryAfter: response.headers.get("retry-after"),
    });

    const wrongPassword = await read(
      await harness.verify({ token, password: "not-the-password-999" }),
    );
    const unknownToken = await read(
      await harness.verify({
        token: "Z".repeat(43),
        password: VICTIM_PASSWORD,
      }),
    );

    expect(wrongPassword).toEqual(unknownToken);
    expect((await harness.user(ADDRESS))?.email_verified).toBe(0);
  });

  // #99-SR-12
  it("counts a wrong password against the 10 attempts of the link, and then refuses the right one too", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await harness.signUp({ email: ADDRESS, password: VICTIM_PASSWORD });
    await harness.flush();
    const token = harness.mail.lastToken(ADDRESS);

    const statuses = [];
    for (let i = 0; i < 10; i += 1)
      statuses.push(
        (await harness.verify({ token, password: `wrong-guess-${String(i)}` }))
          .status,
      );
    const afterTen = await harness.verify({ token, password: VICTIM_PASSWORD });

    expect(statuses).toEqual(Array(10).fill(400));
    expect(afterTen.status).toBe(429);
    expect(Number(afterTen.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await harness.user(ADDRESS))?.email_verified).toBe(0);
  });

  // #99-SR-12
  it("works with the right password once, and the link cannot be used again after it succeeded", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await harness.signUp({ email: ADDRESS, password: VICTIM_PASSWORD });
    await harness.flush();
    const token = harness.mail.lastToken(ADDRESS);

    const first = await harness.verify({ token, password: VICTIM_PASSWORD });
    const second = await harness.verify({ token, password: VICTIM_PASSWORD });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "token_used" });
  });
});
