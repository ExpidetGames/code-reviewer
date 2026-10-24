// SPDX-License-Identifier: Apache-2.0

// The proof that the privacy search of the catalog journey (#435) is not blind. The texts below carry a model id, a
// provider and a key in the shapes a page or an answer really holds them, and the search has to reject every one. They
// are made here with their own encoders, written out one by one, and not with `formsOf` of the search: a form the search
// forgets is a text it passes, which is what this file exists to show. The clean texts are the opposite half: names the
// search must not mistake for a leak.
import type { Surface } from "./member-scan";

export type Sentinels = {
  modelId: string;
  providerId: string;
  providerLabel: string;
  key: string;
};

const base64 = (text: string) => Buffer.from(text).toString("base64");

/** Texts that each carry one thing the search looks for, in the shape of a place a member reads. Every one must leak. */
export function plantedLeaks(subject: Sentinels): Surface[] {
  const { modelId, providerId, providerLabel, key } = subject;
  const slug = modelId.split("/")[1] ?? modelId;
  const maker = modelId.split("/")[0] ?? modelId;
  return [
    {
      name: "the model id in the text of a page",
      text: `<main><h1>Run 4</h1><p>Reviewed with ${modelId} in 3 s.</p></main>`,
    },
    {
      name: "the model id in an RSC payload (a component prop)",
      text: `5:["$","span",null,{"className":"text-sm","children":"${modelId}"}]\n6:["$","$L7",null,{"model":"${modelId}"}]`,
    },
    {
      name: "the model id escaped inside the script of a page",
      text: `<script>self.__next_f.push([1,"{\\"model\\":\\"${modelId.replace(/\//g, "\\/")}\\"}"])</script>`,
    },
    {
      name: "the model id with its slash as a unicode escape",
      text: `{"model":"${modelId.replace(/\//g, "\\u002f").replace(/:/g, "\\u003a")}"}`,
    },
    {
      name: "the model id in a URL",
      text: `<a href="/w/team/runs?model=${encodeURIComponent(modelId)}">filter</a>`,
    },
    {
      name: "the model id percent-encoded twice",
      text: `redirect=/runs%3Fmodel%3D${encodeURIComponent(encodeURIComponent(modelId))}`,
    },
    {
      name: "the model id as HTML entities",
      text: `<p>${modelId.replace(/\//g, "&#x2F;").replace(/:/g, "&#58;")}</p>`,
    },
    {
      name: "the model id in capitals (a CSS text-transform)",
      text: `RUN 4 · ${modelId.toUpperCase()}`,
    },
    {
      name: "the model id in another letter case",
      text: `Model: ${maker[0]?.toUpperCase() ?? ""}${maker.slice(1)}/${slug.toUpperCase()}`,
    },
    {
      name: "the model id as base64 in a data attribute",
      text: `<div data-x="${base64(modelId)}"></div>`,
    },
    {
      name: "the model id as base64 one byte into a longer text",
      text: `<div data-x="${base64(`a${modelId}`)}"></div>`,
    },
    {
      name: "the model id as base64 two bytes into a longer text",
      text: `<div data-x="${base64(`ab${modelId}`)}"></div>`,
    },
    {
      name: "the model name without its maker",
      text: `Run finished: ${slug.split(":")[0] ?? slug} answered`,
    },
    {
      name: "the maker of the model",
      text: `<span class="vendor">${maker}</span>`,
    },
    {
      name: "the id of the provider in a payload",
      text: `{"provider":"${providerId}","configured":true}`,
    },
    {
      name: "the label of the provider in a card",
      text: `<h2>Remove the ${providerLabel} key</h2>`,
    },
    {
      name: "the label of the provider in capitals",
      text: `REMOVE THE ${providerLabel.toUpperCase()} KEY`,
    },
    {
      name: "the key in a failure message",
      text: `401 from the provider: invalid key ${key}`,
    },
    {
      name: "the key percent-encoded in a URL",
      text: `https://example.test/cb?token=${encodeURIComponent(key)}`,
    },
    {
      name: "the key cut short",
      text: `key ${key.slice(0, key.length - 4)}…`,
    },
    {
      name: "the first characters of the key",
      text: `starts with ${key.slice(0, 12)}`,
    },
    {
      name: "the key as base64",
      text: `Authorization: Basic ${base64(key)}`,
    },
    {
      name: "the key after a prefix, as base64",
      text: `x=${base64(`user:${key}`)}`,
    },
  ];
}

/** Texts a page of the product carries. None of them is a leak, and the search has to pass all of them. */
export function cleanTexts(): Surface[] {
  return [
    {
      name: "the choice of an entry",
      text: `<fieldset data-field="catalogEntryDiff"><label>Small</label><label>Big</label>Quick passes over small changes.</fieldset>`,
    },
    {
      name: "a run that failed in words",
      text: `Failed: the review option chosen for this project is not available. 1,280 tokens.`,
    },
    {
      name: "an RSC payload with ids that are not models",
      text: `1:["$","$L2",null,{"workspaceSlug":"catalog-m","runId":"0b2f6f5e-8a3c-49f5-ae0c-5c1e1a2f9d11"}]`,
    },
    {
      name: "the words of the Plan page",
      text: `Not included in your plan · Manage plan · Model access is provided and billed via code-review.com`,
    },
  ];
}
