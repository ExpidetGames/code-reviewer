// SPDX-License-Identifier: LicenseRef-Proprietary

// A fake models.dev (loopback only) for the tests of the app's catalog fetch (#548): `GET /api.json` answers the trimmed
// fixture of `fakes/fixtures/models-dev/` (a real copy, see its README) or whatever a test scripts instead: another body,
// a status, text that is no JSON, an oversized body, a slow answer, a connection that never answers. It counts the
// requests, so a test can prove that a switched-off fetch makes none. The app finds it through `MODELS_DEV_URL`.
// A journey that runs the fake as a process of its own (`main.ts`, #554) scripts it over HTTP: `GET /__fake/health`,
// `GET /__fake/fixture` (the trimmed fixture, to change and send back) and `POST /__fake/respond` (a JSON body: what
// `/api.json` answers from now on).
// Dummy values only; state is in memory.
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { keepConnectionsOpen } from "../keep-alive.ts";

export const MODELS_DEV_FIXTURE_PATH = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "models-dev",
  "api.json",
);

/** A fresh copy of the fixture, for a test to change and hand to `respondWith`. */
export function modelsDevFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(MODELS_DEV_FIXTURE_PATH, "utf8")) as Record<
    string,
    unknown
  >;
}

type Script =
  | { kind: "json"; body: unknown }
  | { kind: "text"; text: string; status: number; contentType: string }
  | { kind: "status"; status: number; headers: Record<string, string> }
  | { kind: "oversize"; bytes: number }
  | { kind: "hang" };

export type ModelsDevFake = {
  /** The address to put in `MODELS_DEV_URL`. */
  readonly url: string;
  /** How many requests arrived, of any path. */
  readonly requests: number;
  /** Answers 200 with this body as JSON (the default is the fixture). */
  respondWith(body: unknown): void;
  /** Answers with this text as it is, for a body that is no JSON. */
  respondWithText(text: string, status?: number, contentType?: string): void;
  /** Answers with this status and an empty body (500, 429, a 302 with a `location`). */
  respondWithStatus(status: number, headers?: Record<string, string>): void;
  /** Answers 200 with a body of this many bytes, sent in chunks, that ends only when the reader gives up. */
  respondWithOversize(bytes: number): void;
  /** Accepts the connection and never answers. */
  hang(): void;
  /** Back to the fixture, and the request counter to zero. */
  reset(): void;
  stop(): Promise<void>;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function send(response: ServerResponse, script: Script): void {
  switch (script.kind) {
    case "json":
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(script.body));
      return;
    case "text":
      response.writeHead(script.status, { "content-type": script.contentType });
      response.end(script.text);
      return;
    case "status":
      response.writeHead(script.status, script.headers);
      response.end();
      return;
    case "oversize": {
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      let sent = 0;
      const next = () => {
        while (sent < script.bytes) {
          sent += chunk.length;
          if (!response.write(chunk)) {
            response.once("drain", next);
            return;
          }
        }
        response.end();
      };
      response.on("close", () => {
        sent = script.bytes;
      });
      next();
      return;
    }
    case "hang":
      return;
  }
}

/** The address of the fake: a port of the OS's choosing, or `port` when the app under test has to know it when it starts. */
export async function startModelsDevFake(
  options: { port?: number } = {},
): Promise<ModelsDevFake> {
  let script: Script = { kind: "json", body: modelsDevFixture() };
  let requests = 0;
  const open = new Set<ServerResponse>();
  const server: Server = createServer((request, response) => {
    requests += 1;
    open.add(response);
    response.on("close", () => open.delete(response));
    const path = request.url?.split("?")[0];
    if (path === "/__fake/health" && request.method === "GET") {
      response.writeHead(200);
      response.end("ok");
      return;
    }
    if (path === "/__fake/fixture" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(modelsDevFixture()));
      return;
    }
    if (path === "/__fake/respond" && request.method === "POST") {
      void readBody(request).then((text) => {
        try {
          script = { kind: "json", body: JSON.parse(text) as unknown };
          response.writeHead(204);
        } catch {
          response.writeHead(400);
        }
        response.end();
      });
      return;
    }
    if (path !== "/api.json") {
      response.writeHead(404);
      response.end();
      return;
    }
    send(response, script);
  });
  keepConnectionsOpen(server);
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}/api.json`,
    get requests() {
      return requests;
    },
    respondWith(body) {
      script = { kind: "json", body };
    },
    respondWithText(text, status = 200, contentType = "application/json") {
      script = { kind: "text", text, status, contentType };
    },
    respondWithStatus(status, headers = {}) {
      script = { kind: "status", status, headers };
    },
    respondWithOversize(bytes) {
      script = { kind: "oversize", bytes };
    },
    hang() {
      script = { kind: "hang" };
    },
    reset() {
      script = { kind: "json", body: modelsDevFixture() };
      requests = 0;
    },
    async stop() {
      for (const response of open) response.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
