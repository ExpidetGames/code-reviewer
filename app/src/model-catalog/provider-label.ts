// SPDX-License-Identifier: LicenseRef-Proprietary

// The name of the model provider a member reads next to an entry of the catalog (#675). A workspace on the code-review.com key
// picks a provider and then a model like any other workspace, so the provider is the maker of the model, never the product
// name and never the router the key goes through. Only this label leaves the operator's side of an entry: the model id and
// the provider id stay with the operator (ADR 0005). Pure: no database, no network.
//
// This is the one place outside the adapters that knows makers by name (`structure.test.ts` lists it): the prefix of a model id
// that goes through a router (`maker/model`) is not a provider of the registry, so its display name cannot come from there.
import { llmProviderDescriptors } from "../llm/providers/index.ts";

/** The makers whose name is not the plain capitalised id a router uses for them (`x-ai`, `meta-llama`, `openai`). */
const MAKER_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  "x-ai": "xAI",
  "meta-llama": "Meta",
  mistralai: "Mistral AI",
  qwen: "Qwen",
  cohere: "Cohere",
  perplexity: "Perplexity",
  amazon: "Amazon",
  microsoft: "Microsoft",
  nvidia: "NVIDIA",
  moonshotai: "Moonshot AI",
  "z-ai": "Z.ai",
  minimax: "MiniMax",
  openrouter: "OpenRouter",
  ai21: "AI21",
  allenai: "Ai2",
  nousresearch: "Nous Research",
  "bytedance-seed": "ByteDance Seed",
  "stepfun-ai": "StepFun",
};

/** `acme-labs` becomes `Acme Labs`; a name nobody listed is still readable. */
function capitalised(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** A router marks the maker of a "latest" alias with a leading `~` (`~anthropic/claude-sonnet-latest`); the maker is the same. */
function nameOfMaker(id: string): string {
  const maker = id.replace(/^~+/, "").toLowerCase();
  return MAKER_NAMES[maker] ?? capitalised(maker);
}

/**
 * The label for an entry. A model id of the shape `maker/model` (a model that goes through a router) has its maker's name; every
 * other provider serves its own models and is named by the registry's label.
 */
export function providerLabelOf(entry: {
  provider: string;
  modelId: string;
}): string {
  const slash = entry.modelId.indexOf("/");
  if (slash > 0) return nameOfMaker(entry.modelId.slice(0, slash));
  return (
    llmProviderDescriptors.find(entry.provider)?.label ??
    nameOfMaker(entry.provider)
  );
}
