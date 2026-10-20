// SPDX-License-Identifier: Apache-2.0

// The handlers behind the routes of the LLM keys of a workspace, with their collaborators passed in so the
// route files only wire the real ones and tests wire the real services over a test database:
//
//   GET    /api/w/:workspace/llm-keys/:provider        whether the key of the provider is configured (every member)
//   PUT    /api/w/:workspace/llm-keys/:provider        { apiKey? }   save; an empty or missing apiKey keeps the stored one
//   DELETE /api/w/:workspace/llm-keys/:provider        remove the key of this provider
//   POST   /api/w/:workspace/llm-keys/:provider/test   { apiKey? }   ask the provider whether the key is accepted
//
// `/api/w/:workspace/llm-key` and `/llm-key/test` stay as an alias for the default provider (their body may name
// the provider, `provider`, which must then be the default one). A body that names another provider than the
// address is refused (`provider_invalid`); a provider in the address that is not registered is 404
// `provider_not_found`, after the workspace and the role were settled.
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
import type { NativeCatalogReader } from "../native-providers/catalog.ts";
import {
  withNativeProviders,
  type KeyProviderLookup,
} from "../native-providers/lookup.ts";
import { checkLlmApiKey } from "./config.ts";
import { llmProviderDescriptors } from "./providers/index.ts";
import type { LlmKeyTestService } from "./key-test.ts";
import type {
  LlmKeyIssue,
  WorkspaceLlmKeyService,
  WorkspaceLlmKeyStatus,
} from "./workspace-key.ts";

/** A provider name and a key of up to 4096 characters, which JSON may escape to six bytes each. */
export const LLM_KEY_REQUEST_MAX_BYTES = 32 * 1024;

const NO_STORE = { "cache-control": "no-store" };

type RefusalCode =
  JsonBodyErrorCode | "rate_limited" | "forbidden" | "provider_not_found";

const STATUS: Record<RefusalCode, number> = {
  ...JSON_BODY_ERROR_STATUS,
  rate_limited: 429,
  forbidden: 403,
  provider_not_found: 404,
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
  /**
   * The catalog of providers (#555). With it, the address may name a catalog provider: reading and removing a key work for
   * any supported one, saving and testing need one that is offered (not blocked, not unlisted). Without it only the registry's
   * providers have a key here, as before.
   */
  catalog?: Pick<NativeCatalogReader, "providerAvailable">;
  /** The providers an address may name; the registry (and the catalog providers when `catalog` is given) by default. */
  providers?: KeyProviderLookup;
};

/**
 * Every handler works on the key of one provider: the one in the address, or the default provider for the alias
 * routes. `provider` is as the address had it (the alias passes the default provider's id).
 */
export type LlmKeyRouteHandlers = {
  get(
    request: Request,
    access: WorkspaceAccess,
    provider: string,
  ): Promise<Response>;
  put(
    request: Request,
    access: WorkspaceAccess,
    provider: string,
  ): Promise<Response>;
  remove(
    request: Request,
    access: WorkspaceAccess,
    provider: string,
  ): Promise<Response>;
  test(
    request: Request,
    access: WorkspaceAccess,
    provider: string,
  ): Promise<Response>;
};

/** A body that names a provider must name the one of the address. */
function bodyNamesAnotherProvider(
  body: Record<string, unknown>,
  provider: string,
  lookup: KeyProviderLookup,
): boolean {
  return (
    body.provider !== undefined && lookup.find(body.provider)?.id !== provider
  );
}

export function createLlmKeyRouteHandlers({
  keys,
  tester,
  catalog,
  providers = catalog === undefined
    ? llmProviderDescriptors
    : withNativeProviders(llmProviderDescriptors),
}: LlmKeyRouteDependencies): LlmKeyRouteHandlers {
  /** The provider of the address: the lookup's id exactly, with no trimming and no case folding (as `slotOf` does). */
  const providerOfPath = (raw: string): string | undefined => {
    const found = providers.find(raw)?.id;
    return found === raw ? found : undefined;
  };
  /**
   * A catalog provider may carry a new key, or be tested, only while it is offered; a blocked one answers like an unknown one.
   * The registry's providers are always available.
   */
  const available = async (provider: string): Promise<boolean> =>
    llmProviderDescriptors.ids.some((id) => id === provider) ||
    (catalog !== undefined && (await catalog.providerAvailable(provider)));
  // The second line behind the route's own action check: the handler asks the matrix as well.
  const mayManage = (access: WorkspaceAccess) =>
    can(access.role, "manage_llm_key");

  return {
    async get(_request, access, raw) {
      const provider = providerOfPath(raw);
      if (provider === undefined) return refusal("provider_not_found");
      const canManage = mayManage(access);
      return done({
        canManage,
        key: viewOf(await keys.status(provider), canManage),
      });
    },

    async put(request, access, raw) {
      if (!mayManage(access)) return refusal("forbidden");
      const provider = providerOfPath(raw);
      if (provider === undefined || !(await available(provider)))
        return refusal("provider_not_found");
      const body = await readJsonObject(request, LLM_KEY_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      if (bodyNamesAnotherProvider(body.value, provider, providers))
        return invalid([{ field: "provider", code: "provider_invalid" }]);
      const result = await keys.save(
        { provider, apiKey: body.value.apiKey },
        access.user.id,
      );
      if (!result.ok) return invalid(result.issues);
      return done({
        ok: true,
        changed: result.changed,
        key: viewOf(result.status, true),
      });
    },

    async remove(request, access, raw) {
      if (!mayManage(access)) return refusal("forbidden");
      const provider = providerOfPath(raw);
      if (provider === undefined) return refusal("provider_not_found");
      if (isCrossSite(request)) return refusal("cross_site_request");
      return done({ ok: true, removed: await keys.remove(provider) });
    },

    async test(request, access, raw) {
      if (!mayManage(access)) return refusal("forbidden");
      const provider = providerOfPath(raw);
      if (provider === undefined || !(await available(provider)))
        return refusal("provider_not_found");
      const body = await readJsonObject(request, LLM_KEY_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      if (bodyNamesAnotherProvider(body.value, provider, providers))
        return invalid([{ field: "provider", code: "provider_invalid" }]);

      // A key typed into the field is checked as it is (and forgotten); with an empty field the stored key of
      // this provider is.
      let apiKey: string;
      const typedValue = body.value.apiKey;
      const typed =
        typedValue !== undefined &&
        typedValue !== null &&
        !(typeof typedValue === "string" && typedValue.trim() === "");
      if (typed) {
        const checked =
          typeof typedValue === "string"
            ? checkLlmApiKey(typedValue)
            : { ok: false as const };
        if (!checked.ok)
          return invalid([{ field: "apiKey", code: "api_key_invalid" }]);
        apiKey = checked.key;
      } else {
        const stored = await keys.reveal(provider);
        if (!stored.ok)
          return invalid([{ field: "apiKey", code: "api_key_required" }]);
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
