// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down, in the built server, that the routes which carry their own authentication stay out of
// the login protection: a request without a session reaches them and is answered by the route, not
// redirected to the login page and not turned away with the guard's 401.
import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";

test.describe("routes with their own authentication", () => {
  // CR-43-T02
  test("the GitHub App webhook is answered by its own signature check, not by the login protection", async ({
    request,
  }) => {
    const response = await request.post("/api/webhooks/github-app", {
      data: "{}",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "00000000-0000-4000-8000-000000000000",
        "x-hub-signature-256": "sha256=00",
      },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({
      error: "WEBHOOK_SIGNATURE_INVALID",
    });
  });

  // CR-43-T02
  test("a correctly signed delivery gets through the login protection and is accepted by the route", async ({
    request,
  }) => {
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const signature = `sha256=${createHmac("sha256", e2eEnv.githubAppWebhookSecret).update(body).digest("hex")}`;

    const response = await request.post("/api/webhooks/github-app", {
      data: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "00000000-0000-4000-8000-000000000001",
        "x-hub-signature-256": signature,
      },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(202);
  });

  test("the health route answers without a session", async ({ request }) => {
    const response = await request.get("/api/health", { maxRedirects: 0 });

    expect(response.status()).toBe(200);
  });
});
