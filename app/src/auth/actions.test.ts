// SPDX-License-Identifier: Apache-2.0

// Pins down the gates of the login form's Server Functions: a way to sign in that the admin switched off
// is refused here too, before Better Auth is asked, because the form calls Better Auth directly and never
// passes the HTTP interface (src/auth/http.ts) that has the same gate.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignInMethods } from "../admin/sign-in-methods.ts";

const mocks = vi.hoisted(() => ({
  methods: vi.fn<() => Promise<SignInMethods>>(),
  signInEmail: vi.fn(() => Promise.resolve({})),
  signInSocial: vi.fn(() =>
    Promise.resolve({ url: "https://github.example/authorize" }),
  ),
  limiterCheck: vi.fn(() => Promise.resolve({ allowed: true as const })),
}));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock("./auth.ts", () => ({
  getAuth: () => ({
    api: { signInEmail: mocks.signInEmail, signInSocial: mocks.signInSocial },
  }),
}));
vi.mock("./github-auth.ts", () => ({
  getGithubAuth: () =>
    Promise.resolve({ api: { signInSocial: mocks.signInSocial } }),
}));
vi.mock("./sign-in-runtime.ts", () => ({
  getSignInMethods: mocks.methods,
  getSignInLimiter: () => ({
    check: mocks.limiterCheck,
    succeeded: () => Promise.resolve(),
  }),
}));

import { signInWithGithub, signInWithPassword } from "./actions.ts";

function redirectedTo(error: unknown): string | null {
  const digest = (error as { digest?: string } | null)?.digest ?? "";
  return /^NEXT_REDIRECT;[a-z]+;([^;]+);/.exec(digest)?.[1] ?? null;
}

async function run(action: () => Promise<void>): Promise<string | null> {
  return redirectedTo(
    await action().then(
      () => null,
      (thrown: unknown) => thrown,
    ),
  );
}

function form(): FormData {
  const data = new FormData();
  data.set("email", "admin@example.com");
  data.set("password", "a-long-password-1234");
  return data;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the email and password form", () => {
  // #98-SIGN-IN-METHODS
  it("is refused with the reason, without counting an attempt or asking Better Auth, when the way is off", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: false, github: true });

    const target = await run(() => signInWithPassword(form()));

    expect(target).toBe("/login?error=sign_in_method_disabled");
    expect(mocks.limiterCheck).not.toHaveBeenCalled();
    expect(mocks.signInEmail).not.toHaveBeenCalled();
  });

  it("signs in when the way is on", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: true, github: false });

    const target = await run(() => signInWithPassword(form()));

    expect(target).toBe("/");
    expect(mocks.signInEmail).toHaveBeenCalledTimes(1);
  });
});

describe("the GitHub button", () => {
  // #98-SIGN-IN-METHODS
  it("is refused with the reason, without asking Better Auth, when the way is off", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: true, github: false });

    const target = await run(signInWithGithub);

    expect(target).toBe("/login?error=sign_in_method_disabled");
    expect(mocks.signInSocial).not.toHaveBeenCalled();
  });

  it("goes to GitHub when the way is on", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: true, github: true });

    const target = await run(signInWithGithub);

    expect(target).toBe("https://github.example/authorize");
  });
});
