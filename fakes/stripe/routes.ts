// SPDX-License-Identifier: LicenseRef-Proprietary

// The endpoints of the fake Stripe API: the ones the app's client calls (app/src/billing/stripe-client.ts), with Stripe's
// habits where the sandbox showed them: a parameter that is not known is refused (`Received unknown parameter: x`), a
// required one that is missing is named, an unknown object is a 404 `resource_missing`, a list is newest first with
// `limit` and `starting_after`.
//
// What a one-time Checkout session of Managed Payments does not support (`tax_id_collection`, `invoice_creation`,
// `customer_update`, `payment_method_types`, `custom_text`, ...) is refused with an error in Stripe's shape, so that a
// regression in the code that builds the session is caught here. NOTE: the sandbox itself (2026-10-20, API version
// `2025-03-31.basil`) refused only `payment_method_types` and `custom_text`, with the messages used below; it accepted
// the others with a 200, although Stripe's documentation lists them as unsupported. The fake is stricter than the
// sandbox on purpose: it follows the documentation, which is what the money depends on.
import {
  invalidParam,
  invalidRequest,
  missingParam,
  unknownParam,
} from "./errors.ts";
import { loadStripeFixture } from "./fixtures.ts";
import {
  KNOWN_EVENT_TYPES,
  type EventCause,
  type FakeObject,
  type Store,
} from "./store.ts";

export type RouteContext = {
  params: string[];
  /** The query string, read like a form body. */
  query: Record<string, unknown>;
  /** The form body, nested. */
  form: Record<string, unknown>;
  /** Where the fake listens, for the address of the buyer's page. */
  origin: string;
  cause: EventCause;
  store: Store;
};
export type Route = {
  method: "GET" | "POST" | "DELETE";
  pattern: RegExp;
  handler: (context: RouteContext) => { status: number; body: unknown };
};

// --- the shape of the parameters

type Spec = "s" | "meta" | { [key: string]: Spec } | [Spec];

const nameOf = (path: string, key: string) =>
  path === "" ? key : `${path}[${key}]`;

/** Refuses a parameter that is not in the spec, or a value of the wrong kind, as Stripe does. */
function check(spec: Spec, value: unknown, path: string): void {
  if (spec === "s") {
    if (typeof value !== "string")
      throw invalidParam(path, "expected a string.");
    return;
  }
  if (spec === "meta") {
    if (value === "") return;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw invalidParam(path, "expected a set of key-value pairs.");
    const entries = Object.entries(value);
    if (entries.length > 50)
      throw invalidRequest(
        "You have passed too many keys in metadata (at most 50).",
        { param: path },
      );
    for (const [key, item] of entries) {
      if (key.length > 40)
        throw invalidRequest(
          `Metadata key names can be at most 40 characters: ${key}`,
          { param: path },
        );
      if (typeof item !== "string" || item.length > 500)
        throw invalidRequest(
          `Metadata values can be at most 500 characters: ${key}`,
          { param: path },
        );
    }
    return;
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) throw invalidParam(path, "expected a list.");
    value.forEach((item, index) => check(spec[0], item, `${path}[${index}]`));
    return;
  }
  if (value === "") return; // an object is cleared by sending it empty
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalidParam(path, "expected a hash.");
  for (const [key, item] of Object.entries(value)) {
    const known = spec[key];
    if (known === undefined) throw unknownParam(nameOf(path, key));
    check(known, item, nameOf(path, key));
  }
}

function checkAll(
  spec: { [key: string]: Spec },
  params: Record<string, unknown>,
): void {
  check(spec, params, "");
}

const ADDRESS: Spec = {
  line1: "s",
  line2: "s",
  city: "s",
  state: "s",
  postal_code: "s",
  country: "s",
};
const CUSTOMER_FIELDS: { [key: string]: Spec } = {
  name: "s",
  // Probed against the sandbox on 2026-10-21 (2025-03-31.basil): the name of the business, next to `name`.
  business_name: "s",
  email: "s",
  description: "s",
  phone: "s",
  address: ADDRESS,
  preferred_locales: ["s"],
  metadata: "meta",
};
const TAX_ID_TYPES = [
  "eu_vat",
  "gb_vat",
  "ch_vat",
  "no_vat",
  "au_abn",
  "ca_gst_hst",
  "us_ein",
];

const integer = (value: unknown, name: string): number => {
  if (typeof value !== "string" || !/^-?\d{1,15}$/.test(value))
    throw invalidParam(name, "expected an integer.");
  return Number(value);
};

const bool = (value: unknown, name: string): boolean => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidParam(name, "expected a boolean.");
};

const asMeta = (value: unknown): Record<string, string> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, string>)
    : {};

/** A patch of a customer: an empty text clears a field, a metadata key with an empty text is removed. */
function patchOf(
  params: Record<string, unknown>,
  current: FakeObject,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "metadata") {
      if (value === "") {
        patch.metadata = {};
        continue;
      }
      const merged = { ...asMeta(current.metadata) };
      for (const [k, v] of Object.entries(asMeta(value))) {
        if (v === "") delete merged[k];
        else merged[k] = v;
      }
      patch.metadata = merged;
    } else if (key === "address") {
      patch.address =
        value === ""
          ? null
          : { line2: null, state: null, ...(value as object) };
    } else if (key === "preferred_locales") {
      patch.preferred_locales = value === "" ? [] : value;
    } else {
      patch[key] = value === "" ? null : value;
    }
  }
  return patch;
}

// --- lists

function page(
  context: RouteContext,
  items: FakeObject[],
  path: string,
  filters: { [key: string]: Spec } = {},
): { status: number; body: unknown } {
  checkAll({ limit: "s", starting_after: "s", ...filters }, context.query);
  const limit =
    context.query.limit === undefined
      ? 10
      : integer(context.query.limit, "limit");
  if (limit < 1 || limit > 100)
    throw invalidParam("limit", "must be between 1 and 100.");
  const newestFirst = [...items].reverse();
  const after = context.query.starting_after;
  let start = 0;
  if (typeof after === "string") {
    const index = newestFirst.findIndex((item) => item.id === after);
    if (index < 0)
      throw invalidRequest(`No such object: '${after}'`, {
        code: "resource_missing",
        param: "starting_after",
      });
    start = index + 1;
  }
  const data = newestFirst.slice(start, start + limit);
  return {
    status: 200,
    body: {
      object: "list",
      data,
      has_more: start + limit < newestFirst.length,
      url: path,
    },
  };
}

// --- Checkout

const MANAGED_PAYMENTS_DOCS =
  "https://docs.stripe.com/payments/managed-payments/update-checkout#remove-unsupported-parameters";
/** Parameters a one-time session of Managed Payments cannot carry. */
const MANAGED_UNSUPPORTED = [
  "tax_id_collection",
  "invoice_creation",
  "customer_update",
  "payment_method_types",
  "custom_text",
  "automatic_tax",
  "shipping_address_collection",
  "billing_address_collection",
] as const;
// The sandbox (2026-10-21) took txcd_10000000, txcd_10103000, txcd_10103001 and txcd_10105002 and refused txcd_99999999,
// txcd_00000000, txcd_20030000 and a text that is no code: the digital family is what the fake takes. Which other codes the
// real list holds was not probed.
const TAX_CODE = /^txcd_10\d{6}$/;
const TAX_CODE_DOCS =
  "https://docs.stripe.com/payments/managed-payments/eligibility#product-tax-code-requirements";

const CHECKOUT_SPEC: { [key: string]: Spec } = {
  mode: "s",
  line_items: [
    {
      quantity: "s",
      price_data: {
        currency: "s",
        unit_amount: "s",
        tax_behavior: "s",
        product_data: { name: "s", description: "s", tax_code: "s" },
      },
    },
  ],
  success_url: "s",
  cancel_url: "s",
  customer: "s",
  client_reference_id: "s",
  metadata: "meta",
  managed_payments: { enabled: "s" },
  expires_at: "s",
  locale: "s",
  // Known to Checkout, refused on Managed Payments (MANAGED_UNSUPPORTED):
  tax_id_collection: { enabled: "s", required: "s" },
  invoice_creation: {
    enabled: "s",
    invoice_data: { description: "s", metadata: "meta" },
  },
  customer_update: { name: "s", address: "s", shipping: "s" },
  payment_method_types: ["s"],
  custom_text: {
    submit: { message: "s" },
    after_submit: { message: "s" },
    shipping_address: { message: "s" },
    terms_of_service_acceptance: { message: "s" },
  },
  automatic_tax: { enabled: "s" },
  shipping_address_collection: { allowed_countries: ["s"] },
  billing_address_collection: "s",
};

function createSession(context: RouteContext): {
  status: number;
  body: unknown;
} {
  const { form, store } = context;
  checkAll(CHECKOUT_SPEC, form);
  for (const required of ["mode", "success_url", "line_items"])
    if (form[required] === undefined) throw missingParam(required);
  if (form.mode !== "payment")
    throw invalidRequest(
      "Invalid mode: this fake supports only mode=payment.",
      { param: "mode" },
    );

  const managed =
    form.managed_payments === undefined
      ? false
      : bool(
          (form.managed_payments as Record<string, unknown>).enabled,
          "managed_payments[enabled]",
        );
  if (managed) {
    // The first unsupported parameter in the order the request has them, like the sandbox does.
    for (const key of Object.keys(form)) {
      if (!(MANAGED_UNSUPPORTED as readonly string[]).includes(key)) continue;
      throw invalidRequest(
        key === "custom_text"
          ? "You cannot use custom_text with Managed Payments."
          : `Unsupported parameter: ${key}. Managed Payments handles this parameter for you. See ${MANAGED_PAYMENTS_DOCS} for more details.`,
      );
    }
  }

  const items = form.line_items as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any -- checked against CHECKOUT_SPEC above
  if (items.length === 0)
    throw invalidParam("line_items", "must not be empty.");
  const lineItems: Array<{ quantity: number; unitAmount: number }> = [];
  const currencies = new Set<string>();
  items.forEach((item, index) => {
    const at = `line_items[${index}]`;
    const priceData = item.price_data as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any -- checked against CHECKOUT_SPEC above
    if (priceData === undefined) throw missingParam(`${at}[price_data]`);
    if (item.quantity === undefined) throw missingParam(`${at}[quantity]`);
    for (const required of ["currency", "unit_amount", "product_data"])
      if (priceData[required] === undefined)
        throw missingParam(`${at}[price_data][${required}]`);
    const productData = priceData.product_data as Record<string, string>;
    if (productData.name === undefined)
      throw missingParam(`${at}[price_data][product_data][name]`);
    const quantity = integer(item.quantity, `${at}[quantity]`);
    const unitAmount = integer(
      priceData.unit_amount,
      `${at}[price_data][unit_amount]`,
    );
    if (quantity < 1)
      throw invalidParam(`${at}[quantity]`, "must be at least 1.");
    if (unitAmount < 1)
      throw invalidParam(`${at}[price_data][unit_amount]`, "must be positive.");
    if (
      !["exclusive", "inclusive", "unspecified"].includes(
        priceData.tax_behavior ?? "unspecified",
      )
    )
      throw invalidParam(
        `${at}[price_data][tax_behavior]`,
        "must be one of exclusive, inclusive, unspecified.",
      );
    if (!/^[a-z]{3}$/.test(priceData.currency))
      throw invalidParam(
        `${at}[price_data][currency]`,
        "must be a three letter currency code.",
      );
    if (managed) {
      if (productData.tax_code === undefined)
        throw invalidRequest(
          `Invalid ${at}: the product tax code is missing. Set the product's tax_code field to an eligible product tax code. See ${TAX_CODE_DOCS} for more details.`,
        );
      if (!TAX_CODE.test(productData.tax_code))
        throw invalidRequest(
          `Invalid ${at}: this product tax code is ineligible for Managed Payments. Update the product's tax_code field to an eligible product tax code. See ${TAX_CODE_DOCS} for more details.`,
        );
    }
    currencies.add(priceData.currency);
    lineItems.push({ quantity, unitAmount });
  });
  if (currencies.size > 1)
    throw invalidRequest("You cannot combine currencies on a single order.");

  const params: Record<string, unknown> = {
    client_reference_id: form.client_reference_id ?? null,
    metadata: asMeta(form.metadata),
    success_url: form.success_url,
    cancel_url: form.cancel_url ?? null,
    locale: form.locale ?? null,
    managed_payments: { enabled: managed },
    customer: null,
  };
  if (
    typeof form.client_reference_id === "string" &&
    form.client_reference_id.length > 200
  )
    throw invalidParam(
      "client_reference_id",
      "must be at most 200 characters.",
    );
  if (typeof form.customer === "string") {
    store.existingCustomer(form.customer, "customer", 400);
    params.customer = form.customer;
  }
  const flag = (key: "tax_id_collection" | "invoice_creation") =>
    (form[key] as Record<string, unknown> | undefined)?.enabled;
  if (flag("tax_id_collection") !== undefined)
    params.tax_id_collection = {
      enabled: bool(flag("tax_id_collection"), "tax_id_collection[enabled]"),
      required: "never",
    };
  if (flag("invoice_creation") !== undefined)
    params.invoice_creation = {
      ...(loadStripeFixture("checkout-session").invoice_creation as object),
      enabled: bool(flag("invoice_creation"), "invoice_creation[enabled]"),
    };
  if (form.expires_at !== undefined) {
    const expiresAt = integer(form.expires_at, "expires_at");
    const now = store.seconds();
    if (expiresAt < now + 1800 || expiresAt > now + 86_400)
      throw invalidParam(
        "expires_at",
        "must be between 30 minutes and 24 hours from now.",
      );
    params.expires_at = expiresAt;
  }

  const session = store.createSession(
    { lineItems, currency: [...currencies][0] as string, params },
    context.origin,
    context.cause,
  );
  return { status: 200, body: session };
}

// --- webhook endpoints

function createEndpoint(context: RouteContext): {
  status: number;
  body: unknown;
} {
  const { form, store } = context;
  checkAll(
    {
      url: "s",
      enabled_events: ["s"],
      description: "s",
      api_version: "s",
      metadata: "meta",
    },
    form,
  );
  if (form.url === undefined) throw missingParam("url");
  if (form.enabled_events === undefined) throw missingParam("enabled_events");
  let url: URL;
  try {
    url = new URL(form.url as string);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("protocol");
  } catch {
    // The real API wants a public https address; the fake takes http on loopback too, because it delivers to it.
    throw invalidParam("url", "Not a valid URL");
  }
  const events = form.enabled_events as string[];
  events.forEach((type, index) => {
    if (
      type !== "*" &&
      !(KNOWN_EVENT_TYPES as readonly string[]).includes(type)
    )
      throw invalidRequest(
        `Invalid enabled_events[${index}]: must be one of ${KNOWN_EVENT_TYPES.join(", ")}, or *`,
        { param: `enabled_events[${index}]` },
      );
  });
  const endpoint = store.createEndpoint({
    url: url.toString(),
    enabled_events: events,
    ...(typeof form.description === "string"
      ? { description: form.description }
      : {}),
    ...(typeof form.api_version === "string"
      ? { api_version: form.api_version }
      : {}),
    metadata: asMeta(form.metadata),
  });
  // The secret is in the answer to the create and in no other.
  return {
    status: 200,
    body: { ...endpoint, secret: store.secretOf(endpoint.id) },
  };
}

// --- the table

const ID = "([A-Za-z0-9_]+)";

export function createRoutes(): Route[] {
  return [
    {
      method: "GET",
      pattern: /^\/v1\/account$/,
      handler: () => ({ status: 200, body: loadStripeFixture("account") }),
    },

    {
      method: "POST",
      pattern: /^\/v1\/customers$/,
      handler: ({ form, store, cause }) => {
        checkAll(
          { ...CUSTOMER_FIELDS, tax_id_data: [{ type: "s", value: "s" }] },
          form,
        );
        const { tax_id_data: taxIdData = [], ...rest } = form as {
          tax_id_data?: Array<{ type?: string; value?: string }>;
        } & Record<string, unknown>;
        taxIdData.forEach((entry, index) => {
          if (entry.type === undefined)
            throw missingParam(`tax_id_data[${index}][type]`);
          if (entry.value === undefined)
            throw missingParam(`tax_id_data[${index}][value]`);
          if (!TAX_ID_TYPES.includes(entry.type))
            throw invalidParam(
              `tax_id_data[${index}][type]`,
              `${entry.type} is not a tax id type this fake knows.`,
            );
          if (entry.value === "")
            throw invalidParam(
              `tax_id_data[${index}][value]`,
              "must not be empty.",
            );
        });
        const params = patchOf(rest, { id: "", metadata: {} });
        const created = store.createCustomer(
          { address: null, preferred_locales: [], metadata: {}, ...params },
          taxIdData as Array<{ type: string; value: string }>,
          cause,
        );
        return { status: 200, body: created };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/v1/customers/${ID}$`),
      handler: ({ params, query, store }) => {
        checkAll({ expand: ["s"] }, query);
        const expand = (query.expand as string[] | undefined) ?? [];
        for (const item of expand)
          if (item !== "tax_ids")
            throw invalidRequest(
              `This property cannot be expanded (${item}).`,
              { param: "expand" },
            );
        const id = params[0] as string;
        const found = store.getCustomer(id);
        if (found === "deleted")
          return {
            status: 200,
            body: { id, object: "customer", deleted: true },
          };
        const list = store.taxIdsOf(id);
        return {
          status: 200,
          body: expand.includes("tax_ids")
            ? {
                ...found,
                tax_ids: {
                  object: "list",
                  data: list,
                  has_more: false,
                  total_count: list.length,
                  url: `/v1/customers/${id}/tax_ids`,
                },
              }
            : found,
        };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/v1/customers/${ID}$`),
      handler: ({ params, form, store, cause }) => {
        checkAll(CUSTOMER_FIELDS, form);
        const id = params[0] as string;
        const current = store.existingCustomer(id, "id", 404);
        return {
          status: 200,
          body: store.updateCustomer(id, patchOf(form, current), cause),
        };
      },
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^/v1/customers/${ID}$`),
      handler: ({ params, store, cause }) => {
        const id = params[0] as string;
        store.deleteCustomer(id, cause);
        return { status: 200, body: { id, object: "customer", deleted: true } };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/v1/customers/${ID}/tax_ids$`),
      handler: ({ params, form, store }) => {
        checkAll({ type: "s", value: "s" }, form);
        if (form.type === undefined) throw missingParam("type");
        if (form.value === undefined) throw missingParam("value");
        if (!TAX_ID_TYPES.includes(form.type as string))
          throw invalidParam(
            "type",
            `${String(form.type)} is not a tax id type this fake knows.`,
          );
        const id = params[0] as string;
        store.existingCustomer(id, "id", 404);
        return {
          status: 200,
          body: store.addTaxId(id, form as { type: string; value: string }),
        };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/v1/customers/${ID}/tax_ids$`),
      handler: (context) => {
        const id = context.params[0] as string;
        context.store.existingCustomer(id, "id", 404);
        return page(
          context,
          context.store.taxIdsOf(id),
          `/v1/customers/${id}/tax_ids`,
        );
      },
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^/v1/customers/${ID}/tax_ids/${ID}$`),
      handler: ({ params, store }) => {
        store.deleteTaxId(params[0] as string, params[1] as string);
        return {
          status: 200,
          body: { id: params[1], object: "tax_id", deleted: true },
        };
      },
    },

    {
      method: "POST",
      pattern: /^\/v1\/checkout\/sessions$/,
      handler: createSession,
    },
    {
      method: "GET",
      pattern: new RegExp(`^/v1/checkout/sessions/${ID}$`),
      handler: ({ params, store }) => ({
        status: 200,
        body: store.getSession(params[0] as string),
      }),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/v1/checkout/sessions/${ID}/expire$`),
      handler: ({ params, form, store, cause }) => {
        checkAll({}, form);
        return {
          status: 200,
          body: store.expireSession(params[0] as string, cause),
        };
      },
    },

    {
      method: "GET",
      pattern: new RegExp(`^/v1/payment_intents/${ID}$`),
      handler: ({ params, store }) => ({
        status: 200,
        body: store.getPaymentIntent(params[0] as string),
      }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/v1/charges/${ID}$`),
      handler: ({ params, store }) => ({
        status: 200,
        body: store.getCharge(params[0] as string),
      }),
    },

    {
      method: "GET",
      pattern: /^\/v1\/invoices$/,
      handler: (context) => {
        const { customer, status } = context.query;
        // Like Stripe, a list of invoices is of one customer (or of the account), and a customer Stripe does not know (never
        // made, deleted, or made under the key of the other environment) is a 400 "No such customer", not an empty list.
        const ignoreFilter = context.store.invoiceCustomerFilterIgnored();
        if (typeof customer === "string" && !ignoreFilter)
          context.store.existingCustomer(customer, "customer", 400);
        const all = [...context.store.maps.invoices.values()];
        const matching = all.filter(
          (invoice) =>
            (customer === undefined ||
              ignoreFilter ||
              invoice.customer === customer) &&
            (status === undefined || invoice.status === status),
        );
        return page(context, matching, "/v1/invoices", {
          customer: "s",
          status: "s",
        });
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/v1/invoices/${ID}$`),
      handler: ({ params, store }) => ({
        status: 200,
        body: store.getInvoice(params[0] as string),
      }),
    },

    {
      method: "POST",
      pattern: /^\/v1\/refunds$/,
      handler: ({ form, store, cause }) => {
        checkAll(
          {
            payment_intent: "s",
            charge: "s",
            amount: "s",
            reason: "s",
            metadata: "meta",
          },
          form,
        );
        if ((form.charge === undefined) === (form.payment_intent === undefined))
          throw invalidRequest(
            "Must provide exactly one of charge or payment_intent to refund.",
          );
        if (
          form.reason !== undefined &&
          !["duplicate", "fraudulent", "requested_by_customer"].includes(
            form.reason as string,
          )
        )
          throw invalidParam(
            "reason",
            "must be one of duplicate, fraudulent, or requested_by_customer.",
          );
        const { refund } = store.refund(
          {
            ...(typeof form.charge === "string" ? { charge: form.charge } : {}),
            ...(typeof form.payment_intent === "string"
              ? { paymentIntent: form.payment_intent }
              : {}),
            ...(form.amount === undefined
              ? {}
              : { amount: integer(form.amount, "amount") }),
            ...(typeof form.reason === "string" ? { reason: form.reason } : {}),
            metadata: asMeta(form.metadata),
          },
          cause,
        );
        return { status: 200, body: refund };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/v1/refunds/${ID}$`),
      handler: ({ params, store }) => ({
        status: 200,
        body: store.getRefund(params[0] as string),
      }),
    },

    {
      method: "POST",
      pattern: /^\/v1\/webhook_endpoints$/,
      handler: createEndpoint,
    },
    {
      method: "GET",
      pattern: /^\/v1\/webhook_endpoints$/,
      handler: (context) =>
        page(
          context,
          [...context.store.maps.endpoints.values()],
          "/v1/webhook_endpoints",
        ),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/v1/webhook_endpoints/${ID}$`),
      handler: ({ params, store }) => ({
        status: 200,
        body: store.getEndpoint(params[0] as string),
      }),
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^/v1/webhook_endpoints/${ID}$`),
      handler: ({ params, store }) => {
        store.deleteEndpoint(params[0] as string);
        return {
          status: 200,
          body: { id: params[0], object: "webhook_endpoint", deleted: true },
        };
      },
    },
  ];
}
