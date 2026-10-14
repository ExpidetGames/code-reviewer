// SPDX-License-Identifier: Apache-2.0

// The Git part of the fake GitHub: the smart HTTP upload-pack of a repository the test registered, so that
// the runner's own Git transport (`dynamic_review/transport.py`: `GET <repo>.git/info/refs?service=git-upload-pack`
// and `POST <repo>.git/git-upload-pack`, Basic authentication with the user `x-access-token` and an
// installation token) checks a pull request out of a fake, with the unchanged production code. The
// repository is real Git (`git-fixture.ts`) and the protocol is served by the real `git upload-pack`
// (stateless, protocol version 0 like the runner speaks it); only the HTTP framing is done here. The
// authorization of the token is the GitHub App part's (`app-api.ts`). No push, no other service.
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";

/** The installation token of a `Basic x-access-token:<token>` header, or undefined. */
export function basicToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0 || decoded.slice(0, colon) !== "x-access-token")
    return undefined;
  return decoded.slice(colon + 1);
}

async function readRaw(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  // A real Git client compresses a large request.
  return request.headers["content-encoding"] === "gzip"
    ? gunzipSync(body)
    : body;
}

function uploadPack(
  repositoryPath: string,
  input: Buffer,
  advertise: boolean,
): Promise<Buffer> {
  const args = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "uploadpack.allowAnySHA1InWant=true",
    "-c",
    "uploadpack.allowFilter=true",
    "upload-pack",
    "--stateless-rpc",
    ...(advertise ? ["--advertise-refs"] : []),
    repositoryPath,
  ];
  return new Promise((resolve, reject) => {
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: "/nonexistent",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const child = spawn("git", args, {
      // Next's types make NODE_ENV a required variable; Git does not read it.
      env: environment as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`git upload-pack exited with ${String(code)}`)),
    );
    child.stdin.on("error", () => {
      // upload-pack may close its input early; the exit status tells.
    });
    child.stdin.end(input);
  });
}

/**
 * Answers `info/refs` (advertise) or `git-upload-pack` (the request body) for a repository directory. The caller
 * has judged the token and found the repository.
 */
export async function serveUploadPack(
  request: IncomingMessage,
  response: ServerResponse,
  repositoryPath: string,
  advertise: boolean,
): Promise<void> {
  let payload: Buffer;
  try {
    payload = await uploadPack(
      repositoryPath,
      advertise ? Buffer.alloc(0) : await readRaw(request),
      advertise,
    );
  } catch {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("git upload-pack failed");
    return;
  }
  if (advertise) {
    payload = Buffer.concat([
      Buffer.from("001e# service=git-upload-pack\n0000"),
      payload,
    ]);
  }
  response.writeHead(200, {
    "content-type": advertise
      ? "application/x-git-upload-pack-advertisement"
      : "application/x-git-upload-pack-result",
    "cache-control": "no-cache",
    "content-length": String(payload.length),
  });
  response.end(payload);
}
