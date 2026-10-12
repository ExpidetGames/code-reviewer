// SPDX-License-Identifier: Apache-2.0

// The handlers behind the routes of the LLM access of a workspace, with their collaborators passed in so the
// route files only wire the real ones and tests wire the real services over a test database:
//
//   GET    /api/w/:workspace/llm-key        whether a key is configured (every member); details for an Admin or Owner
//   PUT    /api/w/:workspace/llm-key        { provider, apiKey? }   save; an empty or missing apiKey keeps the stored one
//   DELETE /api/w/:workspace/llm-key        remove the key
//   POST   /api/w/:workspace/llm-key/test   { provider?, apiKey? }  ask the provider whether the key is accepted
//
// Who is asking and in which workspace is settled before these run (`withWorkspace`, src/workspaces/access-
// runtime.ts): a Member reaches only GET; the other three need `manage_llm_key` (an Admin or an Owner) and the
// route refuses a Member before it gets here. The routes read their request the one way every JSON route of the
// app does (src/http/json-body.ts): same site, `application/json` only, a small limit, read and parsed once.
//
// **The key is write-only.** No answer holds it, nor any part of it but the last four characters of a long one
// (for an Admin or Owner only), and nothing is logged. A key typed into the test button is checked and
// forgotten. Every refusal is `{ "error": <code> }` with a stable code and `Cache-Control: no-store`.
import {
  JSON_BODY_ERROR_STATUS,
  readJsonObject,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import { isCrossSite } from "../http/request-checks.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import { can } from "../workspaces/permissions.ts";
import { checkLlmApiKey, LLM_PROVIDERS, type LlmProvider } from "./config.ts";
import type { LlmKeyTestService } from "./key-test.ts";
import type {
  LlmKeyIssue,
  WorkspaceLlmKeyService,
  WorkspaceLlmKeyStatus,
} from "./workspace-key.ts";

/** A provider name and a key of up to 4096 characters, which JSON may escape to six bytes each. */
export const LLM_KEY_REQUEST_MAX_BYTES = 32 * 1024;

const NO_STORE = { "cache-control": "no-store" };

type RefusalCode = JsonBodyErrorCode | "rate_limited" | "forbidden";

const STATUS: Record<RefusalCode, number> = {
  ...JSON_BODY_ERROR_STATUS,
  rate_limited: 429,
  forbidden: 403,
};

function refusal(
  code: RefusalCode,
  extra: { retryAfterSeconds?: number } = {},
): Response {
  return Response.json(
    { error: code },
    {
      status: STATUS[code],
      headers: {
        ...NO_STORE,
        ...(extra.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(extra.retryAfterSeconds) }),
      },
    },
  );
}

/** A field problem: the codes of `LlmKeyIssue`, field by field, never a value. */
function invalid(issues: LlmKeyIssue[]): Response {
  return Response.json(
    { error: "invalid_input", issues },
    { status: STATUS.invalid_input, headers: NO_STORE },
  );
}

function done(body: object): Response {
  return Response.json(body, { headers: NO_STORE });
}

/**
 * What a person may see of the key. Every member learns whether one exists (it decides whether reviews can run);
 * who set it, when, what it was made for and its last four characters are for those who manage it.
 */
function viewOf(status: WorkspaceLlmKeyStatus, canManage: boolean) {
  if (!canManage) return { state: status.state };
  return status;
}

export type LlmKeyRouteDependencies = {
  /** The key service of THE WORKSPACE OF THE REQUEST (made from `access.workspace.id`). */
  keys: WorkspaceLlmKeyService;
  tester: LlmKeyTestService;
};

export type LlmKeyRouteHandlers = {
  get(request: Request, access: WorkspaceAccess): Promise<Response>;
  put(request: Request, access: WorkspaceAccess): Promise<Response>;
  remove(request: Request, access: WorkspaceAccess): Promise<Response>;
  test(request: Request, access: WorkspaceAccess): Promise<Response>;
};

function providerOf(raw: unknown): LlmProvider | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  return LLM_PROVIDERS.find((provider) => provider === value);
}

export function createLlmKeyRouteHandlers({
  keys,
  tester,
}: LlmKeyRouteDependencies): LlmKeyRouteHandlers {
  // The second line behind the route's own action check: the handler asks the matrix as well.
  const mayManage = (access: WorkspaceAccess) =>
    can(access.role, "manage_llm_key");

  return {
    async get(_request, access) {
      const canManage = mayManage(access);
      return done({
        canManage,
        key: viewOf(await keys.status(), canManage),
      });
    },

    async put(request, access) {
      if (!mayManage(access)) return refusal("forbidden");
      const body = await readJsonObject(request, LLM_KEY_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const result = await keys.save(
        { provider: body.value.provider, apiKey: body.value.apiKey },
        access.user.id,
      );
      if (!result.ok) return invalid(result.issues);
      return done({
        ok: true,
        changed: result.changed,
        key: viewOf(result.status, true),
      });
    },

    async remove(request, access) {
      if (!mayManage(access)) return refusal("forbidden");
      if (isCrossSite(request)) return refusal("cross_site_request");
      return done({ ok: true, removed: await keys.remove() });
    },

    async test(request, access) {
      if (!mayManage(access)) return refusal("forbidden");
      const body = await readJsonObject(request, LLM_KEY_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);

      // A key typed into the field is checked as it is (and forgotten); with an empty field the stored key is.
      let provider: LlmProvider;
      let apiKey: string;
      const typedValue = body.value.apiKey;
      const typed =
        typedValue !== undefined &&
        typedValue !== null &&
        !(typeof typedValue === "string" && typedValue.trim() === "");
      if (typed) {
        const checked =
          typeof body.value.apiKey === "string"
            ? checkLlmApiKey(body.value.apiKey)
            : { ok: false as const };
        const chosen = providerOf(body.value.provider ?? "openrouter");
        const issues: LlmKeyIssue[] = [];
        if (chosen === undefined)
          issues.push({ field: "provider", code: "provider_invalid" });
        if (!checked.ok)
          issues.push({ field: "apiKey", code: "api_key_invalid" });
        if (!checked.ok || chosen === undefined) return invalid(issues);
        provider = chosen;
        apiKey = checked.key;
      } else {
        const stored = await keys.reveal();
        if (!stored.ok)
          return invalid([{ field: "apiKey", code: "api_key_required" }]);
        provider = stored.provider;
        apiKey = stored.apiKey.reveal();
      }

      // Counters that cannot be read throw: the route answers 500/503 and the click is not waved through.
      const result = await tester.test({
        workspaceId: access.workspace.id,
        provider,
        apiKey,
      });
      if (!result.ok && result.error === "rate_limited")
        return refusal("rate_limited", {
          retryAfterSeconds: result.retryAfterSeconds,
        });
      return done(result);
    },
  };
}
