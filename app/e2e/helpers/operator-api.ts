// SPDX-License-Identifier: Apache-2.0

// The external service of an operator, played by the journey's script (#285): it calls the operator API of the operator
// app with the bearer token, the way a service that manages plans would. The API never reads a cookie, so these calls
// carry none. Nothing here is a product feature; it is a thin, typed way to send the documented requests and to read
// the answers.
import { request, type APIRequestContext } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

const API = "/api/operator/v1";

export type Limits = {
  diffRunsPerPeriod: number | null;
  dynamicRunsPerPeriod: number | null;
  managedCostLimitMicroUsd: number | null;
  ownKeyCostLimitMicroUsd: number | null;
};

export type EntitlementsWrite = {
  planLabel: string;
  keyMode: "own" | "managed";
  limits: Limits;
  /** Left out, the stored start is kept (or the period starts now when nothing is stored). */
  periodStart?: string;
  suspended: boolean;
  suspensionCode: string | null;
};

export type UsageItem = {
  id: string;
  workspaceId: string;
  jobId: string;
  reviewKind: "diff" | "dynamic";
  keyMode: "own" | "managed";
  /** From before the catalog (#434): null for every run since. */
  modelTier: string | null;
  catalogEntryId: string | null;
  catalogEntryName: string | null;
  costMicroUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  settledAt: string;
  reason: string | null;
};

/** What an answer of the API was: the status, the parsed JSON (null when there is no body) and the raw text. */
export type OperatorAnswer<T = Record<string, unknown>> = {
  status: number;
  body: T;
  text: string;
};

/**
 * A client of the operator API of the app at `baseURL` (the operator app by default). `token` defaults to the right
 * one; a call with another token, or none (`null`), is how a journey shows what the API answers to a stranger.
 */
export async function operatorClient(
  options: { baseURL?: string; token?: string | null } = {},
) {
  const token =
    options.token === undefined ? e2eEnv.operatorApiToken : options.token;
  const context: APIRequestContext = await request.newContext({
    baseURL: options.baseURL ?? e2eEnv.operatorAppUrl,
    extraHTTPHeaders:
      token === null ? {} : { authorization: `Bearer ${token}` },
  });

  async function call<T = Record<string, unknown>>(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<OperatorAnswer<T>> {
    const response = await context.fetch(`${API}${path}`, {
      method,
      ...(body === undefined ? {} : { data: body }),
      // A redirect would hide the answer of the API itself.
      maxRedirects: 0,
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON: the caller reads `text`
    }
    return { status: response.status(), body: parsed as T, text };
  }

  async function ok<T = Record<string, unknown>>(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const answer = await call<T>(method, path, body);
    if (answer.status !== 200)
      throw new Error(
        `${method} ${path} answered ${String(answer.status)}: ${answer.text}`,
      );
    return answer.body;
  }

  /** The workspaces of the instance, oldest id first (the first page is enough for a journey). */
  async function workspaces(): Promise<
    Array<{ id: string; slug: string; createdAt: string }>
  > {
    const body = await ok<{
      workspaces: Array<{ id: string; slug: string; createdAt: string }>;
    }>("GET", "/workspaces?limit=200");
    return body.workspaces;
  }

  return {
    call,
    workspaces,
    async workspaceId(slug: string): Promise<string> {
      const found = (await workspaces()).find(
        (workspace) => workspace.slug === slug,
      );
      if (found === undefined) throw new Error(`No workspace ${slug}.`);
      return found.id;
    },
    putDefaultEntitlements: (entitlements: EntitlementsWrite) =>
      ok("PUT", "/entitlements/default", entitlements),
    putEntitlements: (workspaceId: string, entitlements: EntitlementsWrite) =>
      ok("PUT", `/workspaces/${workspaceId}/entitlements`, entitlements),
    getEntitlements: (workspaceId: string) =>
      ok("GET", `/workspaces/${workspaceId}/entitlements`),
    putPlanManagement: (url: string) => ok("PUT", "/plan-management", { url }),
    redeemHandoff: (token: string) =>
      call<{
        workspaceId?: string;
        workspaceSlug?: string;
        userId?: string;
        role?: string;
        error?: string;
      }>("POST", "/handoff/redeem", { token }),
    /** The usage feed of one workspace: only what was settled more than the safety lag ago is served. */
    async usageOf(workspaceId: string): Promise<UsageItem[]> {
      const body = await ok<{ items: UsageItem[] }>(
        "GET",
        `/workspaces/${workspaceId}/usage?limit=200`,
      );
      return body.items;
    },
    /** The three reads of the usage feed that are not one workspace's list: every workspace, a period, unknown cost. */
    async usageReads(workspaceId: string): Promise<OperatorAnswer[]> {
      return [
        await call("GET", "/usage?limit=200"),
        await call(
          "GET",
          `/workspaces/${workspaceId}/usage/summary?from=2020-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z`,
        ),
        await call(
          "GET",
          "/usage/unknown-cost?from=2020-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z",
        ),
      ];
    },
    async dispose() {
      await context.dispose();
    },
  };
}

export type OperatorClient = Awaited<ReturnType<typeof operatorClient>>;
