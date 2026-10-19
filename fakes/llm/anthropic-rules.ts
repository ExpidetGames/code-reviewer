// SPDX-License-Identifier: Apache-2.0

// What the Claude Messages API refuses with a 400, for the TypeScript fake (#533). The Python fakes have a twin
// (`anthropic_rules.py`) and both answer the same table of cases (`anthropic-rule-cases.json`). The flags that
// decide a case come from the contract file of the model list (`contracts/anthropic-models.v1.json`), never from
// a second list and never from an id.
//
// The rules, read from Anthropic's documentation on 2026-10-19 (`build-with-claude/thinking`,
// `agents-and-tools/tool-use/define-tools`):
//   - a forced `tool_choice` (`any` or a named tool) is a 400 on a model whose `forcedToolChoice` flag is off;
//   - `thinking: {type: "disabled"}` (and a budget) is a 400 on a model whose `thinkingDisabled` flag is off;
//   - `thinking.block_binding` is a 400 without the beta header `thinking-binding-controls-2026-08-01`;
//   - the thinking blocks of an answer must come back unchanged, in order, at the head of the assistant turn that
//     holds the same tool calls (`record` remembers what was issued);
//   - a thinking block is bound to the conversation that produced it: when the `system` text or the set of tools
//     differs from the request that produced it, the request is a 400 unless it asks for
//     `prefix_mismatch_behavior: "drop_block"` (an account created after 2026-08-31 is enforced).
//
// One rule is an ASSUMPTION, not a documented one: the 400 for an assistant turn with `tool_use` that lacks its
// thinking blocks altogether (the "must come back unchanged" check). The documentation says the blocks are
// "required" within a tool-use turn and that modified blocks are a 400, but it does not state the status code for
// omitted ones. The fake takes the conservative reading so that a wire which dropped the blocks cannot pass; the
// manual smoke run of #519 has to confirm it. The Python twin says the same.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

type Json = Record<string, unknown>;
type Model = {
  id: string;
  supports: { forcedToolChoice: boolean; thinkingDisabled: boolean };
};

/** The status and the body of a request the API refuses. */
export type Refusal = { status: number; body: Json };

// Found from the working directory (the app, the Dispatcher or the repository root) and not from this file: the
// Playwright journeys load the fakes as CommonJS, where `import.meta` does not exist.
function contractPath(): string {
  for (
    let directory = resolve(process.cwd());
    ;
    directory = dirname(directory)
  ) {
    const candidate = join(directory, "contracts", "anthropic-models.v1.json");
    if (existsSync(candidate)) return candidate;
    if (dirname(directory) === directory)
      throw new Error("contracts/anthropic-models.v1.json was not found.");
  }
}
const THINKING_KINDS = ["thinking", "redacted_thinking"];

export function invalid(message: string): Refusal {
  return {
    status: 400,
    body: { type: "error", error: { type: "invalid_request_error", message } },
  };
}

function object(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function blocksOf(message: unknown): Json[] {
  const content = object(message)?.content;
  return Array.isArray(content)
    ? content.flatMap((block) => {
        const entry = object(block);
        return entry === null ? [] : [entry];
      })
    : [];
}

function conversationOf(body: Json): string {
  const names = Array.isArray(body.tools)
    ? body.tools.flatMap((tool) => {
        const name = object(tool)?.name;
        return typeof name === "string" ? [name] : [];
      })
    : [];
  const system =
    typeof body.system === "string"
      ? body.system
      : JSON.stringify(body.system ?? null);
  return createHash("sha256")
    .update(JSON.stringify([system, names.sort()]))
    .digest("hex");
}

export class StrictMessagesApi {
  private readonly models: Map<string, Model>;
  // By tool call id: the thinking blocks issued with it and the conversation they are bound to.
  private readonly issued = new Map<
    string,
    { blocks: Json[]; conversation: string }
  >();

  constructor() {
    const document = JSON.parse(readFileSync(contractPath(), "utf8")) as {
      models: Model[];
    };
    this.models = new Map(document.models.map((model) => [model.id, model]));
  }

  /** Remember the thinking blocks an answer carries, for the requests that replay them. */
  record(request: Json, answer: Json): void {
    const content = blocksOf(answer);
    const thinking = content.filter((block) =>
      THINKING_KINDS.includes(String(block.type)),
    );
    if (thinking.length === 0) return;
    const conversation = conversationOf(request);
    for (const block of content)
      if (block.type === "tool_use" && typeof block.id === "string")
        this.issued.set(block.id, { blocks: thinking, conversation });
  }

  /** The 400 of a request the API refuses, or null. A model of no list is not judged here. */
  check(headers: Record<string, string>, body: Json): Refusal | null {
    const model = this.models.get(String(body.model));
    if (model === undefined) return null;
    return (
      this.choice(body, model) ??
      this.thinking(headers, body, model) ??
      this.replayed(body)
    );
  }

  private choice(body: Json, model: Model): Refusal | null {
    const kind = object(body.tool_choice)?.type;
    return (kind === "any" || kind === "tool") &&
      !model.supports.forcedToolChoice
      ? invalid(
          'tool_choice: type "tool" and "any" are not supported for this model.',
        )
      : null;
  }

  private thinking(
    headers: Record<string, string>,
    body: Json,
    model: Model,
  ): Refusal | null {
    const thinking = object(body.thinking);
    if (thinking === null) return null;
    const kind = thinking.type;
    if (
      (kind === "disabled" || kind === "enabled") &&
      !model.supports.thinkingDisabled
    )
      return invalid(
        `thinking.type.${String(kind)}: "${String(kind)}" is not supported for this model.`,
      );
    if (thinking.block_binding === undefined) return null;
    if (!(headers["anthropic-beta"] ?? "").includes(THINKING_BINDING_BETA))
      return invalid("thinking.block_binding: Extra inputs are not permitted");
    const behavior = object(thinking.block_binding)?.prefix_mismatch_behavior;
    return behavior === "error" || behavior === "drop_block"
      ? null
      : invalid("thinking.block_binding.prefix_mismatch_behavior is not valid");
  }

  private replayed(body: Json): Refusal | null {
    if (!Array.isArray(body.messages)) return null;
    const behavior = object(
      object(body.thinking)?.block_binding,
    )?.prefix_mismatch_behavior;
    const conversation = conversationOf(body);
    for (const [index, message] of body.messages.entries()) {
      if (object(message)?.role !== "assistant") continue;
      const content = blocksOf(message);
      const ids = content.flatMap((block) =>
        block.type === "tool_use" && typeof block.id === "string"
          ? [block.id]
          : [],
      );
      const found = ids
        .map((id) => this.issued.get(id))
        .find((entry) => entry !== undefined);
      if (found === undefined) continue;
      const head = content.slice(0, found.blocks.length);
      if (JSON.stringify(head) !== JSON.stringify(found.blocks))
        return invalid(
          `messages.${String(index)}.content: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.`,
        );
      if (conversation !== found.conversation && behavior !== "drop_block")
        return invalid(
          `messages.${String(index)}.content.0: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block".`,
        );
    }
    return null;
  }
}
