// SPDX-License-Identifier: Apache-2.0

// A fake OpenAI-compatible LLM endpoint (OpenRouter shaped, loopback only) for the tests that run
// the real PR-Agent: it is reached through LiteLLM's real OpenRouter code path, which sends
// `POST <api base>/chat/completions` with the key in the `Authorization` header. The fake records
// every request (headers and body, so a test can read the prompt and the key that arrived) and
// answers from scripts:
//
// - a canned reply; `/review` is the only tool (#203), so every prompt gets the review reply;
// - an error for every request (429, 401, ...), optionally quoting the received key in the message
//   like a provider that says "Incorrect API key provided";
// - an agent script (`scriptAgent`, the Dynamic e2e lane, #253): the answers the real, pinned OpenCode gets
//   from the runner's model proxy. A request that offers tools gets the next scripted tool calls and, when they
//   are used up, the structured findings through the engine's `StructuredOutput` tool; a request without tools
//   (the engine's title request) gets plain text. The engine suite has its own Python twin of this
//   (`ScriptedModel` in runner/tests/engine/opencode_support.py);
// - `GET <api base>/key`, the cheap call that tells whether a key is accepted (the app's "test key"
//   button): 200 for an accepted key, 401 for any other once `acceptKeys` names the accepted ones. The
//   keys that arrived are recorded apart (`keyChecks`), so a test can see which key a check carried;
// - `GET <api base>/models/{author}/{slug}/endpoints`, the public model metadata behind the app's check of a
//   Dynamic model (#269): the endpoints of the models a test registered with `setModel` (the request
//   parameters each lists), 404 for any other model. The requests are recorded apart (`modelRequests`).
//
// The replies are canned (`canned.ts`). They satisfy the output contract of the review tool and
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
  /** The names of the tools the request offered (an agent: the engine's tools), in order. */
  tools: string[];
  /** The result of every tool call the request carries, by the id of the call. */
  toolResults: Record<string, string>;
  /** The `provider` object of the body (OpenRouter's routing options, #270); null when absent. */
  provider: Record<string, unknown> | null;
};

/** One request's tool calls of the agent script. */
export type AgentToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

/** What the agent answers: `steps[i]` for the i-th request that offers tools, then `final` for every later one. */
export type AgentScript = {
  steps: AgentToolCall[][];
  /** The structured answer (Dynamic findings, schema version 1) given through `StructuredOutput`. */
  final: Record<string, unknown>;
};

/** One endpoint (provider) of a model in the metadata answer. */
export type FakeModelEndpoint = {
  supported_parameters: string[];
  max_completion_tokens?: number | null;
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
  /** Answers like the model of a Dynamic Review (see `AgentScript`); null is the canned reply again. */
  scriptAgent(script: AgentScript | null): void;
  /** Registers a model for the metadata endpoint; its endpoints list what the test says they support. */
  setModel(id: string, endpoints: FakeModelEndpoint[]): void;
  /** Every metadata request received (path and `Authorization` header, empty when none), in order. */
  modelRequests(): Array<{ path: string; authorization: string }>;
  /** Normal replies, no error, no recorded requests. */
  reset(): void;
  close(): Promise<void>;
};

type ChatMessage = {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
};

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return (tools as Array<{ function?: { name?: unknown } }>).flatMap((tool) =>
    typeof tool.function?.name === "string" ? [tool.function.name] : [],
  );
}

function providerOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolResultsOf(messages: ChatMessage[]): Record<string, string> {
  const results: Record<string, string> = {};
  for (const message of messages)
    if (message.role === "tool" && typeof message.tool_call_id === "string")
      results[message.tool_call_id] =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
  return results;
}

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

/** The kind of prompt a request holds. `/review` is the only tool (#203). */
export function classify(system: string): PromptKind {
  void system;
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
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cost: 0.0001,
    },
  };
}

/**
 * A completion that asks for tool calls, with the fixed token counts a journey can check and the
 * `usage.cost` OpenRouter reports with every answer (a Dynamic run without it stops, #290).
 */
function toolCompletion(model: string, id: string, calls: AgentToolCall[]) {
  return {
    id: "chatcmpl-fake-agent",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((call, position) => ({
            id: `${id}_${String(position)}`,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cost: 0.0001,
    },
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
  let agent: AgentScript | null = null;
  let agentRequests = 0;
  let models = new Map<string, FakeModelEndpoint[]>();
  let modelLog: Array<{ path: string; authorization: string }> = [];

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
      const metadata = /\/models\/([^/]+)\/([^/]+)\/endpoints$/.exec(
        (request.url ?? "").split("?")[0] ?? "",
      );
      if (request.method === "GET" && metadata !== null) {
        modelLog.push({
          path: request.url ?? "",
          authorization: request.headers.authorization ?? "",
        });
        const id = `${decodeURIComponent(metadata[1] ?? "")}/${decodeURIComponent(metadata[2] ?? "")}`;
        const endpoints = models.get(id);
        if (endpoints === undefined)
          return send(404, { error: { message: "Not Found", code: 404 } });
        return send(200, {
          data: {
            id,
            name: id,
            endpoints: endpoints.map((endpoint) => ({
              name: "fake-provider",
              ...endpoint,
            })),
          },
        });
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
        tools: toolNames((body as { tools?: unknown }).tools),
        toolResults: toolResultsOf(messages),
        provider: providerOf((body as { provider?: unknown }).provider),
      });

      if (error !== null) {
        const message = quoteKey
          ? `Incorrect API key provided: ${authorization.split(" ").at(-1) ?? ""}`
          : error.message;
        return send(error.status, { error: { message, code: error.status } });
      }
      if (agent !== null) {
        if (toolNames((body as { tools?: unknown }).tools).length === 0)
          return send(200, completion(model, "ok"));
        const index = agentRequests;
        agentRequests += 1;
        const calls = agent.steps[index] ?? [
          { name: "StructuredOutput", arguments: agent.final },
        ];
        return send(200, toolCompletion(model, `call_${String(index)}`, calls));
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
    setModel(id, endpoints) {
      models.set(id, endpoints);
    },
    modelRequests: () => [...modelLog],
    scriptAgent(script) {
      agent = script;
      agentRequests = 0;
    },
    reset() {
      agent = null;
      agentRequests = 0;
      log = [];
      replies = defaultReplies();
      error = null;
      quoteKey = false;
      accepted = null;
      keyChecks = [];
      models = new Map();
      modelLog = [];
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((failure) => (failure ? reject(failure) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
