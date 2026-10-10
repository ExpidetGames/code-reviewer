// Pins down reading a request body with a size limit: a declared length over the limit is refused
// without reading, a stream that grows past the limit is cut off, and a body of exactly the limit is
// accepted.
import { describe, expect, it } from "vitest";
import { readLimitedBody } from "./limited-body.ts";

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request("https://app.test/hook", {
    method: "POST",
    body,
    headers,
    // Node requires this for a stream body.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

function chunked(chunks: string[], onPull?: () => void): ReadableStream {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      onPull?.();
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  });
}

describe("reading a limited body", () => {
  it("keeps the exact bytes, also when they are not valid UTF-8", async () => {
    const received = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);

    const body = await readLimitedBody(post(received), 10);

    expect(body).toMatchObject({ ok: true });
    if (!body.ok) throw new Error("unreachable");
    expect([...body.bytes]).toEqual([0x7b, 0xff, 0xfe, 0x7d]);
  });

  it("returns the text of a body below the limit", async () => {
    expect(await readLimitedBody(post("héllo"), 100)).toMatchObject({
      ok: true,
      text: "héllo",
    });
  });

  it("accepts a body of exactly the limit and refuses one byte more", async () => {
    expect(await readLimitedBody(post("a".repeat(10)), 10)).toMatchObject({
      ok: true,
    });
    expect(await readLimitedBody(post("a".repeat(11)), 10)).toEqual({
      ok: false,
    });
  });

  it("counts bytes, not characters", async () => {
    expect(await readLimitedBody(post("é".repeat(6)), 10)).toEqual({
      ok: false,
    });
  });

  it("returns an empty text for a request without a body", async () => {
    expect(await readLimitedBody(post(null), 10)).toEqual({
      ok: true,
      bytes: new Uint8Array(),
      text: "",
    });
  });

  // CR-22-T12
  it("refuses a declared length over the limit without reading the body", async () => {
    let pulled = false;
    const request = post(
      chunked(["x"], () => {
        pulled = true;
      }),
      { "content-length": "11" },
    );

    expect(await readLimitedBody(request, 10)).toEqual({ ok: false });
    expect(pulled).toBe(false);
  });

  // CR-22-T12
  it("stops reading a stream without a length once it passed the limit", async () => {
    let pulls = 0;
    const request = post(
      chunked(["aaaaaa", "bbbbbb", "cccccc", "dddddd"], () => pulls++),
    );

    expect(await readLimitedBody(request, 10)).toEqual({ ok: false });
    expect(pulls).toBeLessThan(4);
  });

  // CR-22-T12
  it("does not trust a declared length that is smaller than the body", async () => {
    const request = post("a".repeat(50), { "content-length": "5" });

    expect(await readLimitedBody(request, 10)).toEqual({ ok: false });
  });

  it("ignores a declared length that is not a number and reads the body", async () => {
    const request = post("abc", { "content-length": "many" });

    expect(await readLimitedBody(request, 10)).toMatchObject({
      ok: true,
      text: "abc",
    });
  });
});
