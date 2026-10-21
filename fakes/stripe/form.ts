// SPDX-License-Identifier: Apache-2.0

// Stripe reads a form body into nested parameters: `a[b]=c` is an object, `a[0]=x` and `a[]=x` are a list. This is the same
// reading, with strings as the only leaves (as at Stripe, a number arrives as text), and the same refusal of a key it
// cannot read.
import { invalidRequest } from "./errors.ts";

type Node = Map<string, Node | string>;

const KEY = /^([^[\]]+)((?:\[[^[\]]*\])*)$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

function insert(root: Node, key: string, value: string) {
  const match = KEY.exec(key);
  if (match === null) throw invalidRequest(`Invalid parameter name: ${key}`);
  const segments = [
    match[1] as string,
    ...[...(match[2] ?? "").matchAll(/\[([^[\]]*)\]/g)].map(
      (m) => m[1] as string,
    ),
  ];
  if (segments.some((segment) => FORBIDDEN.has(segment)))
    throw invalidRequest(`Invalid parameter name: ${key}`);
  let node = root;
  segments.forEach((segment, index) => {
    // `a[]=x`: the next free index of the list.
    const name = segment === "" ? String(node.size) : segment;
    if (index === segments.length - 1) {
      node.set(name, value);
      return;
    }
    const existing = node.get(name);
    if (existing instanceof Map) {
      node = existing;
      return;
    }
    const created: Node = new Map();
    node.set(name, created);
    node = created;
  });
}

function toValue(node: Node | string): unknown {
  if (typeof node === "string") return node;
  const keys = [...node.keys()];
  if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key)))
    return keys
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => toValue(node.get(key) as Node | string));
  return Object.fromEntries(
    keys.map((key) => [key, toValue(node.get(key) as Node | string)]),
  );
}

/** The parameters of a form body (or a query string) as nested objects and lists of strings. */
export function parseForm(text: string): Record<string, unknown> {
  const root: Node = new Map();
  for (const [key, value] of new URLSearchParams(text))
    insert(root, key, value);
  return toValue(root) as Record<string, unknown>;
}

/** The same parameters in one fixed form, so two requests can be told apart or equal whatever the order of the keys. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
