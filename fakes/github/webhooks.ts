// Webhook deliveries as GitHub sends them: a JSON body, signed with HMAC-SHA256 of the raw body in
// `X-Hub-Signature-256`, plus `X-GitHub-Event` and `X-GitHub-Delivery`. The payloads in
// `fakes/fixtures/github-webhooks/` are reduced to the fields Code Reviewer reads (dummy data).
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "github-webhooks",
);

/** The parsed payload of `fixtures/github-webhooks/<name>.json`, for example "pull_request.opened". */
export function webhookFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIRECTORY, `${name}.json`), "utf8"),
  ) as Record<string, unknown>;
}

/** The value of the `X-Hub-Signature-256` header for a body. */
export function signWebhookBody(
  body: string | Uint8Array,
  secret: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export type WebhookDeliveryOptions = {
  /** The `X-GitHub-Event` name, for example "pull_request". */
  event: string;
  /** The payload; serialized as JSON unless `body` is given. */
  payload?: unknown;
  /** The exact raw body, when a test needs bytes that are not `JSON.stringify(payload)`. */
  body?: string;
  secret: string;
  /** Where the delivery is POSTed to. */
  url?: string;
  deliveryId?: string;
  /** Replaces the computed signature header (a wrong signature, or `null` to leave it out). */
  signature?: string | null;
};

/** A request exactly like GitHub's delivery: ready to hand to a route handler or a provider. */
export function webhookDelivery(options: WebhookDeliveryOptions): Request {
  const body = options.body ?? JSON.stringify(options.payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": options.event,
    "x-github-delivery": options.deliveryId ?? randomUUID(),
  };
  const signature =
    options.signature === undefined
      ? signWebhookBody(body, options.secret)
      : options.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return new Request(
    options.url ?? "https://app.test/api/webhooks/github-app",
    { method: "POST", headers, body },
  );
}

/** The event name a fixture belongs to: the part of its name before the first dot. */
export function fixtureEvent(name: string): string {
  return name.split(".")[0] as string;
}
