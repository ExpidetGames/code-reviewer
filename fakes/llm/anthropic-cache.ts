// SPDX-License-Identifier: Apache-2.0

// How the Messages API caches a prompt, for the fake LLM (#539). The Python twin is `anthropic_cache.py`; both keep
// the rules of the prompt caching page of the Claude docs:
//
// - the prefix of a request (`tools`, then `system`, then `messages`, block by block) is cached up to every block that
//   carries `cache_control`; the next request that starts with the same blocks reads it;
// - at most four breakpoints (a top-level `cache_control` takes one: it marks the last cacheable block); more is a 400.
//   A mark on an empty text block or a thinking block is a 400, a `ttl` other than `5m` and `1h` is a 400, a 1 hour
//   entry after a 5 minute one is a 400, and so is a mark on a message object (`Extra inputs are not permitted`):
//   the engine's own marks must never reach the provider;
// - a prefix shorter than the model's minimum is not cached, and no error is said;
// - an entry lives 5 minutes (or 1 hour) from the start of the request that wrote or read it;
// - a breakpoint looks for an entry at most 20 positions back (itself the first); a run of consecutive `tool_use`
//   blocks counts as one position, and so does a run of `tool_result` blocks.
//
// A token is a quarter of a character of the block's canonical JSON: only the proportions matter to a test.
import { createHash } from "node:crypto";

export const MAX_BREAKPOINTS = 4;
export const LOOKBACK_POSITIONS = 20;
export const FIVE_MINUTES = 300;
export const ONE_HOUR = 3600;

const MINIMUM_TOKENS: Record<string, number> = {
  "claude-fable-5-1": 512,
  "claude-opus-5-5": 512,
  "claude-opus-5": 512,
  "claude-sonnet-5-5": 512,
  "claude-fable-5": 512,
  "claude-haiku-5-5": 512,
  "claude-opus-4-8": 1024,
  "claude-sonnet-5": 1024,
  "claude-sonnet-4-6": 1024,
  "claude-opus-4-7": 2048,
  "claude-opus-4-6": 4096,
  "claude-opus-4-5": 4096,
  "claude-haiku-4-5": 4096,
};
const DEFAULT_MINIMUM = 4096;
const MESSAGE_FIELDS = new Set(["role", "content"]);
const UNMARKABLE = new Set(["thinking", "redacted_thinking"]);

type Json = Record<string, unknown>;
type Control = { type?: unknown; ttl?: unknown };

/** The API would answer 400 (`invalid_request_error`) with this message. */
export class CacheRequestRejected extends Error {}

export function minimumTokens(model: string): number {
  return MINIMUM_TOKENS[model] ?? DEFAULT_MINIMUM;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function controlOf(value: unknown, where: string): Control | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || value.type !== "ephemeral")
    throw new CacheRequestRejected(
      `${where}.cache_control.type: Input should be 'ephemeral'`,
    );
  if (value.ttl !== undefined && value.ttl !== "5m" && value.ttl !== "1h")
    throw new CacheRequestRejected(
      `${where}.cache_control.ttl: Input should be '5m' or '1h'`,
    );
  return value;
}

function withoutControl(block: Json): Json {
  const { cache_control: _control, ...rest } = block;
  return rest;
}

type Block = {
  role: string;
  content: Json;
  control: Control | null;
  text: string;
  tokens: number;
};

function block(role: string, content: Json, control: Control | null): Block {
  const text = canonical({ role, block: content });
  return { role, content, control, text, tokens: Math.ceil(text.length / 4) };
}

function markable(entry: Block): boolean {
  if (
    typeof entry.content.type === "string" &&
    UNMARKABLE.has(entry.content.type)
  )
    return false;
  return !(entry.content.type === "text" && !entry.content.text);
}

function blocksOf(body: Json): Block[] {
  const blocks: Block[] = [];
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  tools.forEach((tool, index) => {
    if (!isObject(tool))
      throw new CacheRequestRejected(
        `tools.${String(index)}: Input should be an object`,
      );
    const control = controlOf(tool.cache_control, `tools.${String(index)}`);
    blocks.push(block("tools", withoutControl(tool), control));
  });
  const system = body.system;
  if (typeof system === "string")
    blocks.push(block("system", { type: "text", text: system }, null));
  else if (Array.isArray(system))
    (system as unknown[]).forEach((part, index) => {
      if (!isObject(part) || part.type !== "text")
        throw new CacheRequestRejected(
          `system.${String(index)}: Input should be a text block`,
        );
      const control = controlOf(part.cache_control, `system.${String(index)}`);
      blocks.push(block("system", withoutControl(part), control));
    });
  const messages = Array.isArray(body.messages)
    ? (body.messages as unknown[])
    : [];
  messages.forEach((raw, index) => {
    if (!isObject(raw))
      throw new CacheRequestRejected(
        `messages.${String(index)}: Input should be an object`,
      );
    const extra = Object.keys(raw)
      .filter((key) => !MESSAGE_FIELDS.has(key))
      .sort();
    if (extra.length > 0)
      throw new CacheRequestRejected(
        `messages.${String(index)}.${extra[0] ?? ""}: Extra inputs are not permitted`,
      );
    const role = String(raw.role);
    const content = raw.content;
    if (typeof content === "string") {
      blocks.push(block(role, { type: "text", text: content }, null));
      return;
    }
    const pieces = Array.isArray(content) ? (content as unknown[]) : [];
    pieces.forEach((piece, position) => {
      if (!isObject(piece))
        throw new CacheRequestRejected(
          `messages.${String(index)}.content.${String(position)}: bad block`,
        );
      const control = controlOf(
        piece.cache_control,
        `messages.${String(index)}.content.${String(position)}`,
      );
      blocks.push(block(role, withoutControl(piece), control));
    });
  });
  return blocks;
}

/** The position of every block for the look-back: a run of `tool_use` or `tool_result` blocks is one position. */
function positionsOf(blocks: Block[]): number[] {
  const units: number[] = [];
  let current = -1;
  let previous: string | null = null;
  for (const entry of blocks) {
    const kind = String(entry.content.type);
    const identity = `${entry.role}/${kind}`;
    if (
      previous === null ||
      identity !== previous ||
      (kind !== "tool_use" && kind !== "tool_result")
    )
      current += 1;
    previous = identity;
    units.push(current);
  }
  return units;
}

function breakpointsOf(body: Json, blocks: Block[]): Map<number, Control> {
  const marked = new Map<number, Control>();
  blocks.forEach((entry, index) => {
    if (entry.control === null) return;
    if (!markable(entry)) {
      const kind = String(entry.content.type);
      throw new CacheRequestRejected(
        kind === "text"
          ? "cache_control cannot be set for empty text blocks"
          : `cache_control cannot be set on a ${kind} block`,
      );
    }
    marked.set(index, entry.control);
  });
  if ("cache_control" in body) {
    const top = controlOf(body.cache_control, "cache_control");
    const eligible = blocks.flatMap((entry, index) =>
      markable(entry) ? [index] : [],
    );
    const last = eligible.at(-1);
    if (top !== null && last !== undefined) {
      const existing = marked.get(last);
      if (existing !== undefined && existing.ttl !== top.ttl)
        throw new CacheRequestRejected(
          "cache_control: conflicting ttl on the last block",
        );
      if (existing === undefined) marked.set(last, top);
    }
  }
  if (marked.size > MAX_BREAKPOINTS)
    throw new CacheRequestRejected(
      `A maximum of ${String(MAX_BREAKPOINTS)} blocks with cache_control may be provided. Found ${String(marked.size)}.`,
    );
  let seenFive = false;
  for (const index of [...marked.keys()].sort((a, b) => a - b)) {
    const oneHour = marked.get(index)?.ttl === "1h";
    if (oneHour && seenFive)
      throw new CacheRequestRejected(
        "a ttl='1h' cache_control block must not come after a ttl='5m' one",
      );
    seenFive = seenFive || !oneHour;
  }
  return marked;
}

export type CachedUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
};

/** The cache of one API key, and the usage a request gets from it. */
export class PromptCache {
  private entries = new Map<string, number>();

  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now() / 1000) {
    this.clock = clock;
  }

  /** The usage of a request with the counts it earns from the cache; a request the API would refuse throws. */
  usage(
    body: Json,
    outputTokens: number,
    options: { model?: string; minimum?: number } = {},
  ): CachedUsage {
    const blocks = blocksOf(body);
    const controls = breakpointsOf(body, blocks);
    const marked = [...controls.keys()].sort((a, b) => a - b);
    const now = this.clock();
    const keys: string[] = [];
    const sums: number[] = [];
    let previous = "";
    let total = 0;
    for (const entry of blocks) {
      previous = createHash("sha256")
        .update(previous + entry.text)
        .digest("hex");
      keys.push(previous);
      total += entry.tokens;
      sums.push(total);
    }
    const usage: CachedUsage = {
      input_tokens: total,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
    };
    const last = marked.at(-1);
    if (last === undefined) return usage;
    const floor =
      options.minimum ??
      minimumTokens(options.model ?? String(body.model ?? ""));
    // A breakpoint reads the newest entry of the 20 positions up to and including itself.
    const units = positionsOf(blocks);
    let hit: number | null = null;
    for (const position of [...marked].reverse()) {
      for (let candidate = position; candidate >= 0; candidate -= 1) {
        if (
          (units[position] ?? 0) - (units[candidate] ?? 0) >=
          LOOKBACK_POSITIONS
        )
          break;
        const expires = this.entries.get(keys[candidate] ?? "");
        if (expires !== undefined && expires > now) {
          hit = candidate;
          break;
        }
      }
      if (hit !== null) break;
    }
    if ((sums[last] ?? 0) < floor) return usage;
    const lifetime = controls.get(last)?.ttl === "1h" ? ONE_HOUR : FIVE_MINUTES;
    const read = hit === null ? 0 : (sums[hit] ?? 0);
    const written = (sums[last] ?? 0) - read;
    for (const position of marked)
      if ((sums[position] ?? 0) >= floor)
        this.entries.set(keys[position] ?? "", now + lifetime);
    if (hit !== null) this.entries.set(keys[hit] ?? "", now + lifetime);
    usage.input_tokens = total - (sums[last] ?? 0);
    usage.cache_creation_input_tokens = written;
    usage.cache_read_input_tokens = read;
    usage.cache_creation = {
      ephemeral_5m_input_tokens: lifetime === ONE_HOUR ? 0 : written,
      ephemeral_1h_input_tokens: lifetime === ONE_HOUR ? written : 0,
    };
    return usage;
  }
}
