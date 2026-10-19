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
//   parameters each lists), 404 for any other model. The requests are recorded apart (`modelRequests`);
// - the Anthropic Messages API (#511), at the same address (`<api base>` is `.../api/v1`, the path the
//   Anthropic adapter and the runner derive from it): `GET <api base>/models`, the free call behind the key test
//   (the key arrives in `x-api-key`; `acceptKeys` and `failWith` apply to it as well, and every check is recorded
//   in `anthropicKeyChecks`), and `POST <api base>/messages`, answered in the Messages shape with a usage of
//   input, output and cache tokens (a canned review, or the scripted agent as `tool_use` blocks). The requests
//   (headers and parsed body) are recorded in `messageRequests`, so a test can see exactly which parameters
//   reached the provider;
//
// The replies are canned (`canned.ts`). They satisfy the output contract of the review tool and
// say nothing about review quality. The engine suite of the runner has its own Python twin of this
// fake (runner/tests/engine/fake_llm.py). Dummy values only; state is in memory.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StrictMessagesApi } from "./anthropic-rules.ts";
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
  /**
   * The Messages API only (#533): every answer that asks for tools opens with a signed `thinking` block, as a model
   * that always thinks does, and the next request has to give it back (the fake answers a 400 when it does not).
   */
  thinking?: boolean;
};

/** One endpoint (provider) of a model in the metadata answer. */
export type FakeModelEndpoint = {
  supported_parameters: string[];
  max_completion_tokens?: number | null;
  /** #279: what the claim of a Dynamic job reads next to the parameters. Left out, the endpoint states none. */
  context_length?: number | null;
  /** US dollars per token as OpenRouter writes them (`"0.0000005"`). */
  pricing?: { prompt?: string; completion?: string };
  supports_tool_choice?: { required?: boolean };
};

export type FakeLlmError = { status: number; message: string };

/** One request to the Anthropic Messages API as the fake saw it. */
export type FakeMessagesRequest = {
  /** The `x-api-key` header, empty when absent. */
  apiKey: string;
  /** The `anthropic-version` header, empty when absent. */
  version: string;
  /** The parsed body; an unreadable body is an empty object. */
  body: Record<string, unknown>;
};

/** The usage the fake reports for a Messages answer (Anthropic's names). */
export type FakeMessagesUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  /** The thinking tokens, a part of `output_tokens` (not an addition to it). */
  output_tokens_details?: { thinking_tokens: number };
};

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
  /** The `x-api-key` and `anthropic-version` of every `GET /models` received, in order (the Anthropic key test). */
  anthropicKeyChecks(): Array<{ apiKey: string; version: string }>;
  /** Every `POST /messages` received, in order. */
  messageRequests(): FakeMessagesRequest[];
  /** The usage the next Messages answers report (default: 100 input tokens, 50 output tokens, no cache). */
  setMessagesUsage(usage: FakeMessagesUsage): void;
  /**
   * The next `POST /messages` that is accepted answers with this message verbatim (thinking blocks and all), in
   * the order queued, once each; the request is checked as always (#533).
   */
  queueMessagesAnswer(answer: Record<string, unknown>): void;
  /** Registers a model for the metadata endpoint; its endpoints list what the test says they support. */
  setModel(id: string, endpoints: FakeModelEndpoint[]): void;
  /** Every metadata request received (path and `Authorization` header, empty when none), in order. */
  modelRequests(): Array<{ path: string; authorization: string }>;
  /**
   * While on, a request to the chat completions route is recorded when it arrives and answered only when the hold is
   * lifted (`hold(false)`, `reset()`); a client that hangs up meanwhile gets nothing. For a journey that needs a
   * review that is in progress, so it can end the process that runs it.
   */
  hold(on: boolean): void;
  /** Normal replies, no error, no recorded requests, no hold. */
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

const DEFAULT_MESSAGES_USAGE: FakeMessagesUsage = {
  input_tokens: 100,
  output_tokens: 50,
};

/** An Anthropic Messages answer with text. */
function messagesText(model: string, text: string, usage: FakeMessagesUsage) {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
}

/** An Anthropic Messages answer that asks for tool calls. */
function messagesToolUse(
  model: string,
  id: string,
  calls: AgentToolCall[],
  usage: FakeMessagesUsage,
  thinking = false,
) {
  return {
    id: "msg_fake_agent",
    type: "message",
    role: "assistant",
    model,
    content: [
      // A model that always thinks opens with a signed block (summaries are off: the text is empty).
      ...(thinking
        ? [{ type: "thinking", thinking: "", signature: `sig_${id}` }]
        : []),
      ...calls.map((call, position) => ({
        type: "tool_use",
        id: `${id}_${String(position)}`,
        name: call.name,
        input: call.arguments,
      })),
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage,
  };
}

/** The error shape of the Messages API. */
function messagesError(status: number, message: string) {
  const type =
    status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : status === 429
            ? "rate_limit_error"
            : status === 529
              ? "overloaded_error"
              : status >= 500
                ? "api_error"
                : "invalid_request_error";
  return { type: "error", error: { type, message } };
}

function anthropicToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return (tools as Array<{ name?: unknown }>).flatMap((tool) =>
    typeof tool.name === "string" ? [tool.name] : [],
  );
}

function anthropicPrompt(body: Record<string, unknown>): string {
  const parts: string[] = [];
  const system = body.system;
  if (typeof system === "string") parts.push(system);
  if (Array.isArray(system))
    for (const block of system as Array<{ text?: unknown }>)
      if (typeof block.text === "string") parts.push(block.text);
  if (Array.isArray(body.messages))
    for (const message of body.messages as Array<{ content?: unknown }>) {
      if (typeof message.content === "string") parts.push(message.content);
      else if (Array.isArray(message.content))
        for (const block of message.content as Array<{ text?: unknown }>)
          if (typeof block.text === "string") parts.push(block.text);
    }
  return parts.join("\n");
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
  let anthropicChecks: Array<{ apiKey: string; version: string }> = [];
  let messageLog: FakeMessagesRequest[] = [];
  let messagesUsage: FakeMessagesUsage = DEFAULT_MESSAGES_USAGE;
  // What the Claude API refuses with a 400, and the thinking blocks it issued (#533).
  let strictApi = new StrictMessagesApi();
  let queuedAnswers: Array<Record<string, unknown>> = [];
  let holding = false;
  let held: Array<() => void> = [];
  const release = () => {
    const waiting = held;
    held = [];
    for (const answer of waiting) answer();
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const path = (request.url ?? "").split("?")[0] ?? "";
      if (request.method === "GET" && path.endsWith("/models")) {
        // The Anthropic key test: the free list of models, the key in `x-api-key`.
        const apiKey = String(request.headers["x-api-key"] ?? "");
        const version = String(request.headers["anthropic-version"] ?? "");
        anthropicChecks.push({ apiKey, version });
        if (error !== null)
          return send(
            error.status,
            messagesError(
              error.status,
              quoteKey ? `${error.message}: ${apiKey}` : error.message,
            ),
          );
        if (apiKey === "" || (accepted !== null && !accepted.includes(apiKey)))
          return send(
            401,
            messagesError(
              401,
              quoteKey && apiKey !== ""
                ? `invalid x-api-key: ${apiKey}`
                : "invalid x-api-key",
            ),
          );
        return send(200, {
          data: [],
          first_id: null,
          last_id: null,
          has_more: false,
        });
      }
      if (request.method === "POST" && path.endsWith("/messages")) {
        let parsed: Record<string, unknown> = {};
        try {
          const value: unknown = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          );
          if (
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value)
          )
            parsed = value as Record<string, unknown>;
        } catch {
          // an unreadable body is answered like an empty one
        }
        const apiKey = String(request.headers["x-api-key"] ?? "");
        messageLog.push({
          apiKey,
          version: String(request.headers["anthropic-version"] ?? ""),
          body: parsed,
        });
        const model = typeof parsed.model === "string" ? parsed.model : "";
        const answerMessages = () => {
          if (response.destroyed) return;
          if (apiKey === "")
            return send(
              401,
              messagesError(401, "x-api-key header is required"),
            );
          if (error !== null)
            return send(
              error.status,
              messagesError(
                error.status,
                quoteKey ? `${error.message}: ${apiKey}` : error.message,
              ),
            );
          // What the Claude API refuses with a 400 (#533): a forced tool choice or `thinking: disabled` where the
          // model's flags say no, thinking blocks that do not come back as issued, a changed conversation.
          const refusal = strictApi.check(
            Object.fromEntries(
              Object.entries(request.headers).map(([name, value]) => [
                name,
                Array.isArray(value) ? value.join(",") : String(value ?? ""),
              ]),
            ),
            parsed,
          );
          if (refusal !== null) return send(refusal.status, refusal.body);
          const accept = (answer: Record<string, unknown>) => {
            strictApi.record(parsed, answer);
            return send(200, answer);
          };
          const queued = queuedAnswers.shift();
          if (queued !== undefined) return accept(queued);
          const tools = anthropicToolNames(parsed.tools);
          if (agent !== null && tools.length > 0) {
            const index = agentRequests;
            agentRequests += 1;
            const calls = agent.steps[index] ?? [
              { name: "StructuredOutput", arguments: agent.final },
            ];
            return accept(
              messagesToolUse(
                model,
                `toolu_${String(index)}`,
                calls,
                messagesUsage,
                agent.thinking === true,
              ),
            );
          }
          if (agent !== null)
            return accept(messagesText(model, "ok", messagesUsage));
          log.push({
            path: request.url ?? "",
            authorization: `x-api-key ${apiKey}`,
            model,
            kind: "review",
            prompt: anthropicPrompt(parsed),
            tools,
            toolResults: {},
            provider: null,
          });
          return accept(messagesText(model, replies.review, messagesUsage));
        };
        if (holding) held.push(answerMessages);
        else answerMessages();
        return;
      }
      if (request.method === "GET" && path.endsWith("/key")) {
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

      const answer = () => {
        // The client hung up while the request was held: nobody to answer.
        if (response.destroyed) return;
        if (error !== null) {
          const message = quoteKey
            ? `Incorrect API key provided: ${authorization.split(" ").at(-1) ?? ""}`
            : error.message;
          return send(error.status, {
            error: { message, code: error.status },
          });
        }
        if (agent !== null) {
          if (toolNames((body as { tools?: unknown }).tools).length === 0)
            return send(200, completion(model, "ok"));
          const index = agentRequests;
          agentRequests += 1;
          const calls = agent.steps[index] ?? [
            { name: "StructuredOutput", arguments: agent.final },
          ];
          return send(
            200,
            toolCompletion(model, `call_${String(index)}`, calls),
          );
        }
        send(200, completion(model, replies[kind]));
      };
      if (holding) held.push(answer);
      else answer();
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
    anthropicKeyChecks: () => [...anthropicChecks],
    messageRequests: () => [...messageLog],
    setMessagesUsage(usage) {
      messagesUsage = usage;
    },
    queueMessagesAnswer(answer) {
      queuedAnswers.push(answer);
    },
    scriptAgent(script) {
      agent = script;
      agentRequests = 0;
    },
    hold(on) {
      holding = on;
      if (!on) release();
    },
    reset() {
      holding = false;
      release();
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
      anthropicChecks = [];
      messageLog = [];
      messagesUsage = DEFAULT_MESSAGES_USAGE;
      strictApi = new StrictMessagesApi();
      queuedAnswers = [];
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((failure) => (failure ? reject(failure) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
