// SPDX-License-Identifier: Apache-2.0

// A fake OpenAI-compatible LLM endpoint (OpenRouter shaped, loopback only) for the tests that run
// the real PR-Agent: it is reached through LiteLLM's real OpenRouter code path, which sends
// `POST <api base>/chat/completions` with the key in the `Authorization` header. The fake records
// every request (headers and body, so a test can read the prompt and the key that arrived) and
// answers from scripts:
//
// - a reply per kind of prompt (review, improve, reflect, describe, ask), chosen from the system
//   prompt of the request, so one endpoint serves all four commands;
// - an error for every request (429, 401, ...), optionally quoting the received key in the message
//   like a provider that says "Incorrect API key provided";
// - `GET <api base>/key`, the cheap call that tells whether a key is accepted (the app's "test key"
//   button): 200 for an accepted key, 401 for any other once `acceptKeys` names the accepted ones. The
//   keys that arrived are recorded apart (`keyChecks`), so a test can see which key a check carried.
//
// The replies are canned (`canned.ts`). They satisfy the output contract of each PR-Agent tool and
// say nothing about review quality. The engine suite of the runner has its own Python twin of this
// fake (runner/tests/engine/fake_llm.py). Dummy values only; state is in memory.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { defaultReplies, type PromptKind } from "./canned.ts";

export type FakeLlmRequest = {
  path: string;
  /** The whole `Authorization` header, for example `Bearer <key>`. */
  authorization: string;
  model: string;
  /** Which PR-Agent tool the prompt belongs to. */
  kind: PromptKind;
  /** The system and the user messages joined: what the model was asked. */
  prompt: string;
};

export type FakeLlmError = { status: number; message: string };

export type FakeLlm = {
  /** What a job gets as `llm.baseUrl`: `http://127.0.0.1:<port>/api/v1`. */
  baseUrl: string;
  /** Every request received, in order. */
  requests(): FakeLlmRequest[];
  /** Replaces the reply for one kind of prompt. */
  setReply(kind: PromptKind, text: string): void;
  /** Answers every request with this error, whatever it asks for; null is normal again. */
  failWith(error: FakeLlmError | null): void;
  /** Error messages quote the key that arrived, like a provider that says "Incorrect API key". */
  quoteKeyInErrors(on: boolean): void;
  /** The only keys `GET /key` accepts; null (the default) accepts every key. */
  acceptKeys(keys: string[] | null): void;
  /** The whole `Authorization` header of every `GET /key` received, in order. */
  keyChecks(): string[];
  /** Normal replies, no error, no recorded requests. */
  reset(): void;
  close(): Promise<void>;
};

type ChatMessage = { role?: unknown; content?: unknown };

function textOf(messages: ChatMessage[], role: string): string {
  return messages
    .filter((message) => message.role === role)
    .map((message) => {
      const { content } = message;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return (content as Array<{ text?: unknown }>)
        .map((piece) => (typeof piece.text === "string" ? piece.text : ""))
        .join("\n");
    })
    .join("\n");
}

/** Which PR-Agent tool a prompt belongs to, from the first sentence of its system prompt. */
export function classify(system: string): PromptKind {
  const start = system.slice(0, 400).toLowerCase();
  if (start.includes("evaluating code suggestions")) return "reflect";
  if (start.includes("code analysis and suggestions")) return "improve";
  if (start.includes("full description")) return "describe";
  if (start.includes("answer questions")) return "ask";
  return "review";
}

function completion(model: string, content: string) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

export async function startLlmFake(
  options: { host?: string; port?: number } = {},
): Promise<FakeLlm> {
  const host = options.host ?? "127.0.0.1";
  let log: FakeLlmRequest[] = [];
  let replies = defaultReplies();
  let error: FakeLlmError | null = null;
  let quoteKey = false;
  let accepted: string[] | null = null;
  let keyChecks: string[] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (
        request.method === "GET" &&
        (request.url ?? "").split("?")[0]?.endsWith("/key")
      ) {
        const authorization = request.headers.authorization ?? "";
        const key = authorization.split(" ").at(-1) ?? "";
        keyChecks.push(authorization);
        if (error !== null)
          return send(error.status, {
            error: {
              message: quoteKey ? `${error.message}: ${key}` : error.message,
              code: error.status,
            },
          });
        if (accepted !== null && !accepted.includes(key))
          return send(401, {
            error: {
              message: quoteKey
                ? `Incorrect API key provided: ${key}`
                : "No auth credentials found",
              code: 401,
            },
          });
        return send(200, { data: { label: "fake-key", limit: null } });
      }
      if (
        request.method !== "POST" ||
        !(request.url ?? "").split("?")[0]?.endsWith("/chat/completions")
      )
        return send(404, { error: { message: "Not Found", code: 404 } });

      let body: { model?: unknown; messages?: unknown } = {};
      try {
        body = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as typeof body;
      } catch {
        // an unreadable body is answered like an empty one
      }
      const messages = Array.isArray(body.messages)
        ? (body.messages as ChatMessage[])
        : [];
      const model = typeof body.model === "string" ? body.model : "";
      const authorization = request.headers.authorization ?? "";
      const system = textOf(messages, "system");
      const kind = classify(system);
      log.push({
        path: request.url ?? "",
        authorization,
        model,
        kind,
        prompt: `${system}\n${textOf(messages, "user")}`,
      });

      if (error !== null) {
        const message = quoteKey
          ? `Incorrect API key provided: ${authorization.split(" ").at(-1) ?? ""}`
          : error.message;
        return send(error.status, { error: { message, code: error.status } });
      }
      send(200, completion(model, replies[kind]));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://${host}:${String(address.port)}/api/v1`,
    requests: () => [...log],
    setReply(kind, text) {
      replies[kind] = text;
    },
    failWith(next) {
      error = next;
    },
    quoteKeyInErrors(on) {
      quoteKey = on;
    },
    acceptKeys(keys) {
      accepted = keys;
    },
    keyChecks: () => [...keyChecks],
    reset() {
      log = [];
      replies = defaultReplies();
      error = null;
      quoteKey = false;
      accepted = null;
      keyChecks = [];
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((failure) => (failure ? reject(failure) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
