// SPDX-License-Identifier: Apache-2.0

// POST /api/webhooks/github-app: the one webhook URL of the GitHub App (installations, repositories,
// pull requests and comment commands of every installation). Public: no session, the signature of
// the delivery is the authentication. All logic is in src/webhooks/; see its README.
import { getGithubAppWebhookHandler } from "../../../../webhooks/shared.ts";

export async function POST(request: Request): Promise<Response> {
  return getGithubAppWebhookHandler()(request);
}
