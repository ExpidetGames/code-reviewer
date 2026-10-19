// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { stopUrlOf } from "./stop.ts";

describe("the address of the stop call", () => {
  // #487-T01
  it("is the Dispatcher's /stop next to its /dispatch", () => {
    expect(stopUrlOf("https://dispatcher.example.test/dispatch")).toBe(
      "https://dispatcher.example.test/stop",
    );
    expect(stopUrlOf("https://example.test/dispatcher/v1/dispatch")).toBe(
      "https://example.test/dispatcher/v1/stop",
    );
    expect(stopUrlOf("http://127.0.0.1:4010/dispatch")).toBe(
      "http://127.0.0.1:4010/stop",
    );
  });

  // #487-T01
  it("drops a query or fragment of the wake-up address", () => {
    expect(stopUrlOf("https://dispatcher.example.test/dispatch?x=1#y")).toBe(
      "https://dispatcher.example.test/stop",
    );
  });

  // #487-T07
  it("is none when the wake-up address does not end in /dispatch, or is not an address", () => {
    expect(stopUrlOf("https://dispatcher.example.test/hooks/wake")).toBeNull();
    expect(stopUrlOf("https://dispatcher.example.test/")).toBeNull();
    expect(
      stopUrlOf("https://dispatcher.example.test/dispatch/more"),
    ).toBeNull();
    expect(stopUrlOf("not a url")).toBeNull();
  });
});
