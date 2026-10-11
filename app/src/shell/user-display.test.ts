// Pins down what the user menu shows about a person: the name or, without one, the login; at most
// two initials that always fit the avatar circle; and only https avatar addresses.
import { describe, expect, it } from "vitest";
import { displayName, initials, safeAvatarUrl } from "./user-display.ts";

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
    expect(safeAvatarUrl("https://avatars.example.test/u/1")).toBe(
      "https://avatars.example.test/u/1",
    );
    expect(safeAvatarUrl("http://avatars.example.test/u/1")).toBeNull();
    expect(safeAvatarUrl("javascript:alert(1)")).toBeNull();
    expect(safeAvatarUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safeAvatarUrl("not a url")).toBeNull();
    expect(safeAvatarUrl(null)).toBeNull();
    expect(safeAvatarUrl("")).toBeNull();
  });
});
