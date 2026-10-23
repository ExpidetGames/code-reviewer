// SPDX-License-Identifier: Apache-2.0

// Pins down what the user menu shows about a person: the name or, without one, the login; at most
// two initials that always fit the avatar circle; and only https avatar addresses on GitHub's avatar host,
// which is also where the avatar of a GitHub account id points.
import { describe, expect, it } from "vitest";
import {
  displayName,
  githubAvatarUrl,
  initials,
  safeAvatarUrl,
} from "./user-display.ts";

const user = (name: string, login = "octocat") => ({ name, login });

describe("the display name", () => {
  it("is the profile name, or the login when the name is empty or blank", () => {
    expect(displayName(user("Ada Lovelace"))).toBe("Ada Lovelace");
    expect(displayName(user(""))).toBe("octocat");
    expect(displayName(user("   "))).toBe("octocat");
  });
});

describe("the initials", () => {
  it("are the first letters of the first two words in capitals", () => {
    expect(initials(user("ada lovelace byron"))).toBe("AL");
    expect(initials(user("Ada"))).toBe("A");
    expect(initials(user("", "octo-cat"))).toBe("OC");
  });

  it("never grow beyond two characters when a capital is longer than its letter", () => {
    expect(initials(user("ßeta ßigma"))).toBe("ßß");
    expect(Array.from(initials(user("ßeta ßigma"))).length).toBeLessThanOrEqual(
      2,
    );
  });

  it("fall back to a question mark when the name has no letter or digit", () => {
    expect(initials(user("***", "***"))).toBe("?");
  });
});

describe("the avatar address", () => {
  it("is used only when it is an https address", () => {
    expect(safeAvatarUrl("https://avatars.githubusercontent.com/u/1")).toBe(
      "https://avatars.githubusercontent.com/u/1",
    );
    expect(
      safeAvatarUrl("http://avatars.githubusercontent.com/u/1"),
    ).toBeNull();
    expect(safeAvatarUrl("javascript:alert(1)")).toBeNull();
    expect(safeAvatarUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safeAvatarUrl("not a url")).toBeNull();
    expect(safeAvatarUrl(null)).toBeNull();
    expect(safeAvatarUrl("")).toBeNull();
  });
});

describe("the avatar host", () => {
  // #638-T03
  it("is GitHub's avatar host and no other", () => {
    expect(safeAvatarUrl("https://avatars.githubusercontent.com/u/1?v=4")).toBe(
      "https://avatars.githubusercontent.com/u/1?v=4",
    );
    expect(safeAvatarUrl("https://avatars.example.test/u/1")).toBeNull();
    expect(safeAvatarUrl("https://github.com/octocat.png")).toBeNull();
    expect(
      safeAvatarUrl("https://avatars.githubusercontent.com.example.test/u/1"),
    ).toBeNull();
    expect(
      safeAvatarUrl("https://user@avatars.githubusercontent.com:8443/u/1"),
    ).toBeNull();
  });
});

describe("the avatar of a GitHub account", () => {
  // #638-T01, #638-T02
  it("is built from the numeric account id on GitHub's avatar host", () => {
    expect(githubAvatarUrl("5001")).toBe(
      "https://avatars.githubusercontent.com/u/5001?v=4",
    );
    expect(githubAvatarUrl(5001)).toBe(
      "https://avatars.githubusercontent.com/u/5001?v=4",
    );
  });

  // #638-T03
  it("is none for a missing id or one that is not a positive whole number", () => {
    for (const id of [
      null,
      undefined,
      "",
      "0",
      "-1",
      "1.5",
      "12a",
      "../evil",
      "1/../../x",
      0,
      -3,
      1.5,
      Number.NaN,
    ]) {
      expect(githubAvatarUrl(id)).toBeNull();
    }
  });
});
