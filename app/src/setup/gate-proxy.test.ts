// Pins down how the setup gate answers: the setup in place of a page, 503 setup_required with no
// caching, a 404 for the page and the API of a setup that is over, and a refusal (not an open door)
// when the gate cannot tell whether the instance is set up.
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSetupGate } from "./gate-proxy.ts";
import type { SetupState } from "./state.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function gateFor(state: SetupState | Error) {
  return createSetupGate({
    readState: () =>
      state instanceof Error ? Promise.reject(state) : Promise.resolve(state),
  });
}

function request(path: string, method = "GET") {
  return new NextRequest(`http://localhost:3000${path}`, { method });
}

describe("the setup gate as a proxy step", () => {
  // #97-SU-03
  it("serves the setup page in place of the page that was asked for", async () => {
    const response = await gateFor({ kind: "fresh" })(request("/projects"));

    expect(response?.headers.get("x-middleware-rewrite")).toBe(
      "http://localhost:3000/setup",
    );
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  // #97-SU-03
  it("answers 503 setup_required, uncached, for an API route", async () => {
    const response = await gateFor({ kind: "fresh" })(
      request("/api/projects", "POST"),
    );

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "setup_required" });
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("leaves a request alone that the gate lets through", async () => {
    expect(
      await gateFor({ kind: "fresh" })(request("/api/health")),
    ).toBeUndefined();
    expect(
      await gateFor({ kind: "completed" })(request("/projects")),
    ).toBeUndefined();
  });

  // #97-SU-14
  it("answers 404 for the setup page and the setup API once the instance is set up", async () => {
    const page = await gateFor({ kind: "completed" })(request("/setup"));
    const api = await gateFor({ kind: "completed" })(
      request("/api/setup/code", "POST"),
    );

    expect(page?.status).toBe(404);
    expect(page?.headers.get("content-type")).toContain("text/html");
    expect(api?.status).toBe(404);
    expect(await api?.json()).toEqual({ error: "not_found" });
  });

  it("lets the health check and the framework files through without reading the state", async () => {
    const readState = vi.fn(() => Promise.reject(new Error("locked")));
    const gate = createSetupGate({ readState });

    expect(await gate(request("/api/health"))).toBeUndefined();
    expect(await gate(request("/_next/static/chunks/a.js"))).toBeUndefined();
    expect(readState).not.toHaveBeenCalled();
  });

  it("refuses the request, and says nothing about the reason, when the state cannot be read", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await gateFor(
      new Error("database is locked (secret detail)"),
    )(request("/projects"));

    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe("Service unavailable");
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "SETUP_STATE_UNAVAILABLE",
    );
    expect(String(error.mock.calls[0]?.[0])).not.toContain("secret detail");
  });
});
