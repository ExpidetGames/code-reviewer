// SPDX-License-Identifier: Apache-2.0

// Derives `contracts/opencode-providers.v1.json` (#548, part B) from a models.dev body and the pin of OpenCode: which
// providers the pinned OpenCode can drive with a static key and a bundled SDK, with which wire family, and which are left
// out and why. The committed file is the result; a pin bump is the moment to run this again (`pnpm
// opencode-providers:derive`) and to read the diff (a unit test fails while the file and `runner/opencode-pin.json`
// name different commits).
//
// The rules below are read from the pinned source (`packages/opencode/src/provider/provider.ts` at the commit):
// `BUNDLED_PROVIDERS` is the list of SDKs that need no install; the custom loaders decide the wire a provider id uses
// (`openai`, `xai` and `meta` call the Responses API, every other `@ai-sdk/openai` provider goes through
// `languageModel`, which is Responses as well); the cloud and OAuth providers have loaders that mint tokens or sign.
//
// Node runs this file as it is (type stripping), see cli.ts: relative imports with the .ts extension and no
// TypeScript-only runtime syntax.
import {
  AUTH_HEADER_OF_FAMILY,
  BUNDLED_NPM,
  type ExclusionReason,
  type WireFamily,
} from "../../models-dev/wire.ts";

/** The SDKs the pinned OpenCode bundles (`BUNDLED_PROVIDERS`); any other `npm` is installed at run time. */
const BUNDLED_NPM_SET: ReadonlySet<string> = new Set(BUNDLED_NPM);

/** Providers left out by decision (#544, decision 6), whatever their SDK. */
const EXCLUDED_BY_ID: Readonly<Record<string, ExclusionReason>> = {
  "amazon-bedrock": "cloud_iam",
  "google-vertex": "cloud_iam",
  "google-vertex-anthropic": "cloud_iam",
  azure: "cloud_iam",
  "azure-cognitive-services": "cloud_iam",
  "sap-ai-core": "cloud_iam",
  "cloudflare-workers-ai": "cloud_iam",
  "cloudflare-ai-gateway": "cloud_iam",
  "snowflake-cortex": "cloud_iam",
  "github-copilot": "oauth",
  gitlab: "oauth",
  // Left out with the runtime-install providers by the maintainer's decision (#548, part B). The pinned
  // `BUNDLED_PROVIDERS` does list its SDK, so this entry is the one to look at again at a pin bump.
  venice: "runtime_install",
};

/** The wire of a bundled SDK; an SDK that is not here and is bundled speaks a wire of its own. */
const FAMILY_OF_NPM: Readonly<Record<string, WireFamily>> = {
  "@ai-sdk/openai-compatible": "openai-chat",
  "@openrouter/ai-sdk-provider": "openai-chat",
  "@ai-sdk/mistral": "openai-chat",
  "@ai-sdk/groq": "openai-chat",
  "@ai-sdk/deepinfra": "openai-chat",
  "@ai-sdk/cerebras": "openai-chat",
  "@ai-sdk/togetherai": "openai-chat",
  "@ai-sdk/perplexity": "openai-chat",
  "@ai-sdk/vercel": "openai-chat",
  "@ai-sdk/alibaba": "openai-chat",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/xai": "openai-responses",
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/google": "google",
};

/** The custom loaders that pick the wire by provider id, not by SDK (`xai` and `meta` call `responses`). */
const FAMILY_OF_ID: Readonly<Record<string, WireFamily>> = {
  xai: "openai-responses",
  meta: "openai-responses",
};

/** The address an SDK talks to when models.dev names none, read from the SDK's own source. */
const DEFAULT_BASE_URL_OF_NPM: Readonly<Record<string, string>> = {
  "@ai-sdk/anthropic": "https://api.anthropic.com/v1",
  "@ai-sdk/openai": "https://api.openai.com/v1",
  "@ai-sdk/google": "https://generativelanguage.googleapis.com/v1beta",
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
  "@ai-sdk/deepinfra": "https://api.deepinfra.com/v1/openai",
  "@ai-sdk/togetherai": "https://api.together.xyz/v1",
  "@ai-sdk/perplexity": "https://api.perplexity.ai",
};

export type OpencodePin = { version: string; commit: string };

export type ProviderEntry =
  | {
      npm: string;
      family: WireFamily;
      authHeader: (typeof AUTH_HEADER_OF_FAMILY)[WireFamily];
      defaultBaseUrl?: string;
    }
  | { excluded: ExclusionReason };

export type ProvidersFile = {
  version: 1;
  opencode: OpencodePin;
  providers: Record<string, ProviderEntry>;
};

type Candidate = { npm?: unknown; api?: unknown };

function entryOf(id: string, candidate: Candidate): ProviderEntry {
  const byId = EXCLUDED_BY_ID[id];
  if (byId !== undefined) return { excluded: byId };
  const npm = typeof candidate.npm === "string" ? candidate.npm : "";
  const api = typeof candidate.api === "string" ? candidate.api : undefined;
  if (api?.includes("${") === true) return { excluded: "templated_base_url" };
  if (!BUNDLED_NPM_SET.has(npm)) return { excluded: "runtime_install" };
  const family = FAMILY_OF_ID[id] ?? FAMILY_OF_NPM[npm];
  if (family === undefined) return { excluded: "wire_not_supported" };
  const defaultBaseUrl = DEFAULT_BASE_URL_OF_NPM[npm];
  if (api === undefined && defaultBaseUrl === undefined)
    return { excluded: "no_base_url" };
  return {
    npm,
    family,
    authHeader: AUTH_HEADER_OF_FAMILY[family],
    // Only where models.dev names no address: a provider that names one is trusted on first use (part C).
    ...(api === undefined && defaultBaseUrl !== undefined
      ? { defaultBaseUrl }
      : {}),
  };
}

/** The file for a models.dev body (provider id → provider) and the pin it is derived for. */
export function deriveProviders(
  body: unknown,
  opencode: OpencodePin,
): ProvidersFile {
  if (typeof body !== "object" || body === null)
    throw new Error("The models.dev body is not an object.");
  const providers: Record<string, ProviderEntry> = {};
  for (const id of Object.keys(body).sort()) {
    const candidate = (body as Record<string, unknown>)[id];
    providers[id] = entryOf(
      id,
      typeof candidate === "object" && candidate !== null ? candidate : {},
    );
  }
  return { version: 1, opencode, providers };
}
