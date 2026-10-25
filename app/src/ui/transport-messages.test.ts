// SPDX-License-Identifier: LicenseRef-Proprietary

// #690-T03: an answer the page cannot read says which HTTP status it came with, so "the server answered with something
// unexpected" can be told from a proxy page (502), a crash (500) or a login page (200).
import { describe, expect, it } from "vitest";
import { requestJson } from "./json-request.ts";
import {
  describeTransportFailure,
  TRANSPORT_FAILURE_COPY,
  unexpectedResponseCopy,
} from "./transport-messages.ts";

describe("the copy for an unexpected answer", () => {
  // #690-T03
  it("names the HTTP status of an answer that is not JSON", async () => {
    const result = await requestJson(
      () =>
        Promise.resolve(
          new Response("<html>Bad gateway</html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          }),
        ),
      "PUT",
      "/api/x",
      {},
    );

    expect(result).toMatchObject({
      ok: false,
      status: 502,
      code: "UNEXPECTED_RESPONSE",
    });
    if (result.ok) throw new Error("unreachable");
    expect(describeTransportFailure(result.code, result.status)).toBe(
      "The server answered with HTTP 502. Reload the page and try again.",
    );
  });

  // #690-T03
  it("keeps the general sentence when there is no status to name", () => {
    expect(unexpectedResponseCopy(null)).toBe(
      TRANSPORT_FAILURE_COPY.UNEXPECTED_RESPONSE,
    );
    expect(describeTransportFailure("UNEXPECTED_RESPONSE")).toBe(
      TRANSPORT_FAILURE_COPY.UNEXPECTED_RESPONSE,
    );
  });

  // #690-T03
  it("names a status only for the unexpected answer, not for the other transport codes", () => {
    expect(describeTransportFailure("NETWORK_ERROR", 502)).toBe(
      TRANSPORT_FAILURE_COPY.NETWORK_ERROR,
    );
    expect(describeTransportFailure("SOMETHING_ELSE", 502)).toBeUndefined();
  });
});
