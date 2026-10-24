// SPDX-License-Identifier: LicenseRef-Proprietary

// Small helpers shared by the parts of the fake GitHub: answering and reading HTTP messages.
import type { IncomingMessage, ServerResponse } from "node:http";

export function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { "content-type": contentType, ...headers });
  response.end(body);
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  send(response, status, "application/json", JSON.stringify(body), headers);
}

export function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
) {
  send(
    response,
    status,
    "text/html; charset=utf-8",
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake GitHub</title></head><body>${body}</body></html>`,
  );
}

export function redirect(response: ServerResponse, location: URL) {
  response.writeHead(302, { location: location.toString() });
  response.end();
}

export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson<T>(request: IncomingMessage): Promise<T> {
  return JSON.parse(await readBody(request)) as T;
}

export async function readForm(
  request: IncomingMessage,
): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(request));
}
