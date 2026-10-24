// SPDX-License-Identifier: LicenseRef-Proprietary

// Everything a test of the operator API needs: a real SQLite file with the default workspace, the API wired to the
// real repositories, a recording logger, and a `call` that builds requests like an operator's client does.
// `notFound` throws a marker, because in the running server it is Next.js's `notFound()`.
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createPlanHandoffRedeemRepository } from "../db/repositories/plan-handoff-redeem-repository.ts";
import { createPlanHandoffTokensRepository } from "../db/repositories/plan-handoff-tokens-repository.ts";
import { createUsageFeedRepository } from "../db/repositories/usage-feed-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { createOperatorApi } from "../operator-api/api.ts";
import type { OperatorRoute } from "../operator-api/contract.ts";
import { createTestDatabase } from "./test-database.ts";
import { createUsageSeeder } from "./usage-seed.ts";
import { addWorkspace, defaultWorkspaceId } from "./workspaces.ts";

export const TEST_OPERATOR_TOKEN = "test-operator-token-3b8e1d-6a40f2c97e15";

export class NotFoundMarker extends Error {
  constructor() {
    super("not found");
    this.name = "NotFoundMarker";
  }
}

export type CallOptions = {
  /** Sent as `Authorization: Bearer <token>`. Default: the right token. `null` sends no header. */
  token?: string | null;
  /** The whole header value; wins over `token`. */
  authorization?: string | null;
  /** A JSON value (stringified) or, as a string, the raw body text. */
  body?: unknown;
  rawBody?: string;
  contentType?: string | null;
  headers?: Record<string, string>;
};

export function routeOf(path: string): OperatorRoute {
  const url = new URL(path, "http://localhost");
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const rest = parts.slice(3);
  if (rest.length === 1 && rest[0] === "workspaces")
    return { kind: "workspaces" };
  if (
    rest.length === 3 &&
    rest[0] === "workspaces" &&
    rest[2] === "entitlements" &&
    rest[1] !== undefined
  )
    return { kind: "workspace-entitlements", workspaceId: rest[1] };
  if (rest.length === 1 && rest[0] === "usage") return { kind: "usage" };
  if (rest.length === 2 && rest[0] === "usage" && rest[1] === "unknown-cost")
    return { kind: "usage-unknown-cost" };
  if (
    rest.length === 3 &&
    rest[0] === "workspaces" &&
    rest[2] === "usage" &&
    rest[1] !== undefined
  )
    return { kind: "workspace-usage", workspaceId: rest[1] };
  if (
    rest.length === 4 &&
    rest[0] === "workspaces" &&
    rest[2] === "usage" &&
    rest[3] === "summary" &&
    rest[1] !== undefined
  )
    return { kind: "workspace-usage-summary", workspaceId: rest[1] };
  if (rest.length === 2 && rest[0] === "entitlements" && rest[1] === "default")
    return { kind: "default-entitlements" };
  if (rest.length === 1 && rest[0] === "plan-management")
    return { kind: "plan-management" };
  if (rest.length === 2 && rest[0] === "handoff" && rest[1] === "redeem")
    return { kind: "handoff-redeem" };
  return { kind: "unknown" };
}

export async function startOperatorApiHarness(
  options: {
    token?: string | undefined;
    now?: Date;
  } = {},
) {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  let now = options.now ?? new Date("2026-10-14T12:00:00.000Z");
  const lines: string[] = [];
  const errors: string[] = [];
  const token = "token" in options ? options.token : TEST_OPERATOR_TOKEN;
  const api = createOperatorApi({
    token: () => token,
    workspaces: createWorkspacesRepository(db),
    entitlementsFor: (id) =>
      createWorkspaceEntitlementsRepository(db, id, () => now),
    settings: createInstanceSettingsRepository(db, () => now),
    usageFeed: createUsageFeedRepository(db),
    usageFor: (id) => createUsageRecordsRepository(db, id, () => now),
    handoffs: createPlanHandoffRedeemRepository(db, () => now),
    now: () => now,
    logger: {
      info: (line) => lines.push(line),
      error: (line) => errors.push(line),
    },
    notFound: () => {
      throw new NotFoundMarker();
    },
  });

  async function call(
    method: string,
    path: string,
    options: CallOptions = {},
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    const authorization =
      options.authorization !== undefined
        ? options.authorization
        : options.token === null
          ? null
          : `Bearer ${options.token ?? TEST_OPERATOR_TOKEN}`;
    if (authorization !== null) headers.set("authorization", authorization);
    const text =
      options.rawBody ??
      (options.body === undefined ? undefined : JSON.stringify(options.body));
    if (text !== undefined && options.contentType !== null)
      headers.set("content-type", options.contentType ?? "application/json");
    // A GET cannot carry a body in a Request; a client that sends one declares it in the headers.
    const bodyless = method === "GET" || method === "HEAD";
    if (text !== undefined && bodyless)
      headers.set("content-length", String(text.length));
    const request = new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(text === undefined || bodyless ? {} : { body: text }),
    });
    return api.handle(request, routeOf(path));
  }

  return {
    db,
    workspaceId,
    call,
    lines,
    errors,
    api,
    usage: createUsageSeeder(db),
    /** The handoff tokens of a workspace, made the way the route makes them. */
    handoffTokens: (id: string) =>
      createPlanHandoffTokensRepository(db, id, () => now),
    setNow: (next: Date) => {
      now = next;
    },
    addWorkspace: (slug: string) => addWorkspace(db, slug),
  };
}
