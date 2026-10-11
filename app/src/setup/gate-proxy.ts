// The setup gate as a step of the Next.js proxy (src/proxy.ts): it applies the decision of gate.ts
// to a request. Returns a response when the request is answered here (the setup page in place of
// the page that was asked for, `503 setup_required`, 404), or undefined when the request goes on to
// the session check. If the state cannot be read, the request is refused: a gate that cannot tell
// whether the instance is set up must not open.
import { NextResponse, type NextRequest } from "next/server";
import { decideSetupGate } from "./gate.ts";
import type { SetupStateReader } from "./state.ts";

const NO_STORE = { "cache-control": "no-store" };

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function createSetupGate({
  readState,
}: {
  readState: SetupStateReader;
}) {
  return async function setupGate(
    request: NextRequest,
  ): Promise<NextResponse | undefined> {
    const { pathname } = request.nextUrl;
    // The health check and the framework's files are decided without the state (they pass whatever
    // it is), so a hiccup of the database cannot turn the health check into the gate's 503.
    if (pathname === "/api/health" || pathname.startsWith("/_next/"))
      return undefined;
    let decision;
    try {
      decision = decideSetupGate({
        pathname,
        method: request.method,
        state: await readState(),
      });
    } catch {
      console.error(
        "[setup] SETUP_STATE_UNAVAILABLE: could not read whether the instance is set up; the request is refused.",
      );
      return new NextResponse("Service unavailable", {
        status: 503,
        headers: NO_STORE,
      });
    }

    switch (decision.kind) {
      case "pass":
        return undefined;
      case "setup_required":
        return NextResponse.json(
          { error: "setup_required" },
          { status: 503, headers: NO_STORE },
        );
      case "show_setup":
        return NextResponse.rewrite(new URL("/setup", request.url), {
          headers: NO_STORE,
        });
      case "not_found":
        return isApiPath(pathname)
          ? NextResponse.json(
              { error: "not_found" },
              { status: 404, headers: NO_STORE },
            )
          : new NextResponse(
              "<!doctype html><title>404</title><h1>404</h1><p>This page could not be found.</p>",
              {
                status: 404,
                headers: {
                  ...NO_STORE,
                  "content-type": "text/html; charset=utf-8",
                },
              },
            );
    }
  };
}
