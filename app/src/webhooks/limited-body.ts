// Reads a request body as text with a hard size limit, without trusting the declared length: a
// `Content-Length` over the limit is refused before anything is read, and a body without a length (or
// with a wrong one) is cut off as soon as it grows past the limit, so a large body never sits in
// memory.

export type LimitedBody =
  /** `bytes` are exactly what was received; `text` is their UTF-8 decoding, for reading only. */
  { ok: true; bytes: Uint8Array; text: string } | { ok: false };

export async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<LimitedBody> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return { ok: false };
  }
  if (request.body === null)
    return { ok: true, bytes: new Uint8Array(), text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(Buffer.concat(chunks));
  return { ok: true, bytes, text: new TextDecoder().decode(bytes) };
}
