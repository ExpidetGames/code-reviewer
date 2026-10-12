// SPDX-License-Identifier: Apache-2.0

// Deliveries to the webhook route of an app under test, signed like GitHub signs them. The payloads
// are the fixtures of fakes/fixtures (reduced to the fields the app reads), patched to name the
// installation, repository and pull request of a journey.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type APIRequestContext, expect } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

// The fixtures are read here and not through fakes/github/webhooks.ts, which Playwright cannot load
// (it compiles the journeys to CommonJS and that file uses `import.meta`).
function webhookFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        "../fakes/fixtures/github-webhooks",
        `${name}.json`,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export type PullRequestDelivery = {
  /** The fixture used: `pull_request.<action>`. */
  action: "opened" | "synchronize";
  installationId: number;
  repository: {
    id: number;
    fullName: string;
    owner: { login: string; id: number };
  };
  number: number;
  title: string;
  /** The head commit of the pull request after the event. */
  headSha: string;
};

/** The answer of the webhook route for an accepted delivery: `{ status: "accepted", outcome }`. */
export type DeliveryAnswer = { status: string; outcome: string };

/**
 * Sends a `pull_request` event like GitHub does to the app of the project (its `baseURL`) and returns what the app made of it (`outcome` is
 * for example `trigger_enqueued` or `project_not_active`). Expects the answer 202.
 */
export async function deliverPullRequestEvent(
  request: APIRequestContext,
  delivery: PullRequestDelivery,
): Promise<DeliveryAnswer> {
  /* eslint-disable @typescript-eslint/no-explicit-any -- a fixture patched in place */
  const payload = webhookFixture(`pull_request.${delivery.action}`) as Record<
    string,
    any
  >;
  const fullName = delivery.repository.fullName;
  const repo = { id: delivery.repository.id, full_name: fullName };
  payload.installation.id = delivery.installationId;
  payload.repository = {
    ...payload.repository,
    id: delivery.repository.id,
    name: fullName.split("/")[1],
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    owner: { ...delivery.repository.owner, type: "User" },
  };
  payload.number = delivery.number;
  payload.pull_request.number = delivery.number;
  payload.pull_request.title = delivery.title;
  payload.pull_request.html_url = `https://github.com/${fullName}/pull/${String(delivery.number)}`;
  payload.pull_request.head = {
    ...payload.pull_request.head,
    sha: delivery.headSha,
    repo,
  };
  payload.pull_request.base = { ...payload.pull_request.base, repo };
  if ("after" in payload) payload.after = delivery.headSha;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const body = JSON.stringify(payload);
  const response = await request.post("/api/webhooks/github-app", {
    data: body,
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signWebhookBody(
        body,
        e2eEnv.githubAppWebhookSecret,
      ),
    },
  });
  expect(response.status()).toBe(202);
  return (await response.json()) as DeliveryAnswer;
}
