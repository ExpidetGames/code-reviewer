// The stable error codes of the webhook route. A caller (GitHub's delivery log, a test) branches on
// `error`, never on the status text; the response carries nothing else, so it can never echo the body,
// a secret or a signature.
export const WEBHOOK_ERROR_CODES = [
  /** The body is larger than the limit. 413. */
  "WEBHOOK_BODY_TOO_LARGE",
  /** The signature is missing, malformed or does not match the body. 401. */
  "WEBHOOK_SIGNATURE_INVALID",
  /** The `X-GitHub-Event` header is missing or malformed. 400. */
  "WEBHOOK_EVENT_HEADER_INVALID",
  /** The `X-GitHub-Delivery` header is missing or malformed. 400. */
  "WEBHOOK_DELIVERY_HEADER_INVALID",
  /** The body is not valid JSON. 400. */
  "WEBHOOK_BODY_NOT_JSON",
  /** The app cannot check deliveries (for example the webhook secret is not configured). 503. */
  "WEBHOOK_NOT_CONFIGURED",
  /** Handling the delivery failed; the delivery is not remembered, so a redelivery is handled. 5xx. */
  "WEBHOOK_PROCESSING_FAILED",
] as const;
export type WebhookErrorCode = (typeof WEBHOOK_ERROR_CODES)[number];

/** What the route answers with `202`: it only names what happened, for GitHub's delivery log. */
export const WEBHOOK_ACCEPTED_OUTCOMES = [
  /** The event is not one the app uses; nothing was recorded or done. */
  "event_not_used",
  /** The delivery id was handled before; nothing was done. */
  "duplicate",
  "ignored",
  "unknown_installation",
  "integration_disabled",
  "trigger_not_allowed",
  "trigger_enqueued",
  "installation_changed",
] as const;
export type WebhookAcceptedOutcome = (typeof WEBHOOK_ACCEPTED_OUTCOMES)[number];

/** Thrown inside the handler for a failure that has its own answer. */
export class WebhookProcessingError extends Error {
  readonly safeMessage = true as const;
  readonly status: 500 | 503;

  constructor(
    message: string,
    status: 500 | 503 = 500,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WebhookProcessingError";
    this.status = status;
  }
}
