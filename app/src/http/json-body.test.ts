// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how a public JSON route reads its request: only a same-site JSON object within the size
// limit gets through, and the body is read once.
import { describe, expect, it } from "vitest";
import { readJsonObject } from "./json-body.ts";

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    // A streamed body needs it; a text body ignores it.
    duplex: "half",
  } as RequestInit);
}

describe("reading a JSON request", () => {
  it("returns the parsed object", async () => {
    expect(await readJsonObject(post('{"a":1}'), 1024)).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  // #99-SR-14
  it.each([
    "application/x-www-form-urlencoded",
    "text/plain",
    "multipart/form-data; boundary=x",
    "",
  ])("refuses the content type %j", async (type) => {
    const request = post("email=a%40example.com", { "content-type": type });

    expect(await readJsonObject(request, 1024)).toEqual({
      ok: false,
      error: "unsupported_content_type",
    });
  });

  it("accepts a charset parameter and any case of the media type", async () => {
    const request = post("{}", {
      "content-type": "Application/JSON; charset=utf-8",
    });

    expect((await readJsonObject(request, 1024)).ok).toBe(true);
  });

  it("refuses a request from another site before it reads the body", async () => {
    const request = post("{}", { "sec-fetch-site": "cross-site" });

    expect(await readJsonObject(request, 1024)).toEqual({
      ok: false,
      error: "cross_site_request",
    });
    expect(request.bodyUsed).toBe(false);
  });

  it("refuses a body over the limit, declared or not", async () => {
    const declared = post("x".repeat(100), { "content-length": "100" });
    const undeclared = post(new Blob(["x".repeat(100)]).stream());

    expect(await readJsonObject(declared, 10)).toEqual({
      ok: false,
      error: "body_too_large",
    });
    expect(await readJsonObject(undeclared, 10)).toEqual({
      ok: false,
      error: "body_too_large",
    });
  });

  it.each(["", "not json", "[1]", "null", "5", '"text"'])(
    "refuses the body %j that is not a JSON object",
    async (text) => {
      expect(await readJsonObject(post(text), 1024)).toEqual({
        ok: false,
        error: "invalid_input",
      });
    },
  );
});
