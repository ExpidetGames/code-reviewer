// SPDX-License-Identifier: Apache-2.0

// POST /api/webhooks/github-app: the one webhook URL of the GitHub App (installations, repositories,
// pull requests and comment commands of every installation). Public: no session, the signature of
// the delivery is the authentication. All logic is in src/webhooks/; see its README.
import { touched } from "../../../../dispatch/maintenance-shared.ts";
import { getGithubAppWebhookHandler } from "../../../../webhooks/shared.ts";

export async function POST(request: Request): Promise<Response> {
  const response = await getGithubAppWebhookHandler()(request);
  // #395: a delivery that was accepted is a moment at which the database is awake anyway; the repair work
  // of the sweep (expired leases, calls that are due) is done after the response, at most every 30 seconds.
  if (response.status === 202) touched();
  return response;
}
