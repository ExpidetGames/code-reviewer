// Pins down how a login on the allow list is compared with the GitHub id it is bound to: the first
// id wins, a different id is a mismatch, and a store that cannot answer is never a match.
import { describe, expect, it, vi } from "vitest";
import { checkLoginPin, type LoginPins } from "./login-pins.ts";

function pinsReturning(stored: string | null): LoginPins {
  return { pin: vi.fn(() => Promise.resolve(stored)) };
}

describe("comparing an account with the pin of its login", () => {
  // CR-42-T01
  it("matches when the login is bound to this id (also right after it was bound)", async () => {
    expect(await checkLoginPin(pinsReturning("1001"), "octocat", "1001")).toBe(
      "match",
    );
  });

  // CR-42-T03
  it("reports a mismatch when the login is bound to another id", async () => {
    expect(await checkLoginPin(pinsReturning("1001"), "octocat", "2002")).toBe(
      "mismatch",
    );
  });

  it("asks the store to bind this id, so the first one wins", async () => {
    const pins = pinsReturning("1001");

    await checkLoginPin(pins, "OctoCat", "2002");

    expect(pins.pin).toHaveBeenCalledWith("OctoCat", "2002");
  });

  it("is unavailable, never a match, when the store has no answer", async () => {
    expect(await checkLoginPin(pinsReturning(null), "octocat", "1001")).toBe(
      "unavailable",
    );
  });

  it("is unavailable, never a match, when the store fails", async () => {
    const pins: LoginPins = { pin: () => Promise.reject(new Error("locked")) };

    expect(await checkLoginPin(pins, "octocat", "1001")).toBe("unavailable");
  });

  it("is a mismatch for an empty id, which no account has", async () => {
    expect(await checkLoginPin(pinsReturning("1001"), "octocat", "")).toBe(
      "mismatch",
    );
  });
});
