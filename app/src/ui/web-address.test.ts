// Pins down which repository addresses the list may turn into a link: web addresses only.
import { describe, expect, it } from "vitest";
import { webAddress } from "./web-address.ts";

describe("the address of a repository", () => {
  it("is kept for an https or http address", () => {
    expect(webAddress("https://github.com/acme/widgets")).toBe(
      "https://github.com/acme/widgets",
    );
    expect(webAddress("http://127.0.0.1:4010/acme/widgets")).toBe(
      "http://127.0.0.1:4010/acme/widgets",
    );
  });

  it("is dropped for a script address, a data address or text that is no address", () => {
    expect(webAddress("javascript:alert(1)")).toBeNull();
    expect(webAddress("data:text/html,<b>x</b>")).toBeNull();
    expect(webAddress("not an address")).toBeNull();
    expect(webAddress("")).toBeNull();
  });
});
