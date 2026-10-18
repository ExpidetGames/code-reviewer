// SPDX-License-Identifier: Apache-2.0

// The in-memory state of the fake Paddle and the builders of its entities. An entity has the fields of the sample
// in fakes/fixtures/paddle (a test compares the key sets), with made-up ids (ids.ts). Nothing here is persisted.
import { randomBytes } from "node:crypto";
import { conflict, notFound } from "./errors.ts";
import { fakeId } from "./ids.ts";

export type FakeEntity = { id: string; [field: string]: unknown };
export type Cycle = {
  interval: "day" | "week" | "month" | "year";
  frequency: number;
};
export type Money = { amount: string; currency_code: string };

export type FakePrice = FakeEntity & {
  product_id: string;
  description: string;
  /** `standard` is a catalog price; `custom` is made for one transaction and hidden from the catalog. */
  type: "standard" | "custom";
  status: "active" | "archived";
  billing_cycle: Cycle | null;
  unit_price: Money;
};

export type FakeSubscription = FakeEntity & {
  status: string;
  customer_id: string;
  currency_code: string;
  next_billed_at: string | null;
  canceled_at: string | null;
  current_billing_period: { starts_at: string; ends_at: string } | null;
  billing_cycle: Cycle | null;
  scheduled_change: {
    action: string;
    effective_at: string;
    resumes_at: null;
  } | null;
  items: Array<{
    status: string;
    quantity: number;
    price: {
      id: string;
      product_id: string;
      description: string;
      unit_price: Money;
    };
    [field: string]: unknown;
  }>;
  custom_data: Record<string, unknown> | null;
};

export type FakeTransaction = FakeEntity & {
  status: string;
  customer_id: string | null;
  subscription_id: string | null;
  currency_code: string;
  items: Array<{ price_id: string; quantity: number; proration: null }>;
  custom_data: Record<string, unknown> | null;
};

export type StoreOptions = {
  now: () => number;
  /** Where Paddle's checkout page is; the transaction's `checkout.url` points at `<this>?_ptxn=<id>`. */
  checkoutUrl: string;
  /** Copy the custom data of a paid transaction to its subscription. Paddle's behaviour is undocumented (S4). */
  copyTransactionCustomData: boolean;
};

export type Store = ReturnType<typeof createStore>;

/** Paddle writes timestamps with microseconds. */
export const stamp = (ms: number) =>
  new Date(ms).toISOString().replace("Z", "000Z");

export function addCycle(from: Date, cycle: Cycle): Date {
  const next = new Date(from);
  const n = cycle.frequency;
  if (cycle.interval === "day") next.setUTCDate(next.getUTCDate() + n);
  if (cycle.interval === "week") next.setUTCDate(next.getUTCDate() + 7 * n);
  if (cycle.interval === "month") next.setUTCMonth(next.getUTCMonth() + n);
  if (cycle.interval === "year") next.setUTCFullYear(next.getUTCFullYear() + n);
  return next;
}

export function createStore(options: StoreOptions) {
  const products = new Map<string, FakeEntity>();
  const prices = new Map<string, FakePrice>();
  const transactions = new Map<string, FakeTransaction>();
  const subscriptions = new Map<string, FakeSubscription>();
  const customers = new Set<string>();
  const notificationSettings = new Map<string, FakeEntity>();

  const timestamp = () => stamp(options.now());

  function get<T>(map: Map<string, T>, id: string): T {
    const found = map.get(id);
    if (found === undefined) throw notFound(id);
    return found;
  }

  function activePrice(id: string): FakePrice {
    const price = get(prices, id);
    if (price.status === "archived")
      // Unverified code name (errors.ts); the 409 and the constraint (an archived entity is not used) are the contract.
      throw conflict("entity_archived", `Price ${id} is archived`);
    return price;
  }

  function subscriptionItem(priceId: string, quantity: number, at: number) {
    const price = activePrice(priceId);
    const next =
      price.billing_cycle === null
        ? null
        : stamp(addCycle(new Date(at), price.billing_cycle).getTime());
    return {
      status: "active",
      quantity,
      recurring: price.billing_cycle !== null,
      created_at: stamp(at),
      updated_at: stamp(at),
      previously_billed_at: stamp(at),
      next_billed_at: next,
      trial_dates: null,
      price: {
        id: price.id,
        product_id: price.product_id,
        description: price.description,
        unit_price: price.unit_price,
      },
    };
  }

  function buildSubscription(input: {
    priceId: string;
    customerId: string;
    status: string;
    nextBilledAt?: string;
    customData: Record<string, unknown> | null;
  }): FakeSubscription {
    const at = options.now();
    const price = activePrice(input.priceId);
    const cycle = price.billing_cycle ?? {
      interval: "month" as const,
      frequency: 1,
    };
    const end =
      input.nextBilledAt ?? stamp(addCycle(new Date(at), cycle).getTime());
    const endDate = new Date(end);
    const start =
      input.nextBilledAt === undefined
        ? stamp(at)
        : stamp(addNegative(endDate, cycle).getTime());
    customers.add(input.customerId);
    const subscription: FakeSubscription = {
      id: fakeId("sub"),
      status: input.status,
      customer_id: input.customerId,
      address_id: fakeId("add"),
      business_id: null,
      currency_code: price.unit_price.currency_code,
      created_at: stamp(at),
      updated_at: stamp(at),
      started_at: stamp(at),
      first_billed_at: stamp(at),
      next_billed_at: end,
      paused_at: null,
      canceled_at: null,
      collection_mode: "automatic",
      billing_details: null,
      current_billing_period: { starts_at: start, ends_at: end },
      billing_cycle: cycle,
      scheduled_change: null,
      items: [subscriptionItem(price.id, 1, at)],
      custom_data: input.customData,
      import_meta: null,
    };
    subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  return {
    timestamp,
    products,
    prices,
    transactions,
    subscriptions,
    customers,
    notificationSettings,
    /** Whether the list of notification settings carries `endpoint_secret_key` (a switch for tests). */
    listWithSecrets: true,
    /** Page size of the list of notification settings, or null for the plain, unpaginated list (a switch for tests). */
    notificationListPageSize: null as number | null,
    get,
    activePrice,
    subscriptionItem,

    addProduct(input: {
      name: string;
      tax_category: string;
      description?: string | null;
      image_url?: string | null;
      custom_data?: Record<string, unknown> | null;
    }): FakeEntity {
      const product: FakeEntity = {
        id: fakeId("pro"),
        name: input.name,
        description: input.description ?? null,
        type: "standard",
        tax_category: input.tax_category,
        image_url: input.image_url ?? null,
        custom_data: input.custom_data ?? null,
        status: "active",
        import_meta: null,
        created_at: timestamp(),
        updated_at: timestamp(),
      };
      products.set(product.id, product);
      return product;
    },

    addPrice(
      input: Record<string, unknown> & { product_id: string },
    ): FakePrice {
      const product = get(products, input.product_id);
      if (product.status === "archived")
        throw conflict("entity_archived", `Product ${product.id} is archived`);
      const price: FakePrice = {
        id: fakeId("pri"),
        product_id: product.id,
        type: (input.type ?? "standard") as "standard" | "custom",
        description: input.description as string,
        name: input.name ?? null,
        tax_mode: input.tax_mode ?? "account_setting",
        billing_cycle: (input.billing_cycle ?? null) as Cycle | null,
        trial_period: input.trial_period ?? null,
        unit_price: input.unit_price as Money,
        unit_price_overrides: input.unit_price_overrides ?? [],
        quantity: input.quantity ?? { minimum: 1, maximum: 100 },
        status: "active",
        custom_data: input.custom_data ?? null,
        import_meta: null,
        created_at: timestamp(),
        updated_at: timestamp(),
      };
      prices.set(price.id, price);
      return price;
    },

    addTransaction(input: {
      items: Array<{ price_id: string; quantity: number }>;
      customer_id?: string;
      custom_data?: Record<string, unknown>;
    }): FakeTransaction {
      const first = input.items[0];
      const currency =
        first === undefined
          ? "USD"
          : activePrice(first.price_id).unit_price.currency_code;
      for (const item of input.items) activePrice(item.price_id);
      if (input.customer_id !== undefined && !customers.has(input.customer_id))
        throw notFound(input.customer_id);
      const id = fakeId("txn");
      const transaction: FakeTransaction = {
        id,
        status: "draft",
        customer_id: input.customer_id ?? null,
        address_id: null,
        business_id: null,
        currency_code: currency,
        origin: "api",
        subscription_id: null,
        invoice_id: null,
        invoice_number: null,
        collection_mode: "automatic",
        discount_id: null,
        billing_details: null,
        billing_period: null,
        items: input.items.map((item) => ({
          price_id: item.price_id,
          quantity: item.quantity,
          proration: null,
        })),
        custom_data: input.custom_data ?? null,
        payments: [],
        checkout: { url: `${options.checkoutUrl}?_ptxn=${id}` },
        created_at: timestamp(),
        updated_at: timestamp(),
        billed_at: null,
      };
      transactions.set(id, transaction);
      return transaction;
    },

    addSubscription: buildSubscription,

    /** The customer pays the transaction: it is completed and, if it has a recurring item, a subscription starts. */
    payTransaction(
      transactionId: string,
      input: { customerId?: string } = {},
    ): FakeSubscription {
      const transaction = get(transactions, transactionId);
      if (transaction.status === "completed")
        throw conflict(
          "transaction_already_completed",
          `Transaction ${transactionId} is completed`,
        );
      const customerId =
        input.customerId ?? transaction.customer_id ?? fakeId("ctm");
      const recurring = transaction.items.find(
        (item) => activePrice(item.price_id).billing_cycle !== null,
      );
      if (recurring === undefined)
        throw new Error(
          "Only a transaction with a recurring item makes a subscription",
        );
      const subscription = buildSubscription({
        priceId: recurring.price_id,
        customerId,
        status: "active",
        customData: options.copyTransactionCustomData
          ? transaction.custom_data
          : null,
      });
      Object.assign(transaction, {
        status: "completed",
        customer_id: customerId,
        subscription_id: subscription.id,
        updated_at: timestamp(),
        billed_at: timestamp(),
      });
      return subscription;
    },

    addNotificationSetting(input: {
      description: string;
      type: string;
      destination: string;
      subscribed_events: string[];
      api_version?: number;
      traffic_source?: string;
      include_sensitive_fields?: boolean;
    }): FakeEntity {
      const setting: FakeEntity = {
        id: fakeId("ntfset"),
        description: input.description,
        type: input.type,
        destination: input.destination,
        active: true,
        api_version: input.api_version ?? 1,
        include_sensitive_fields: input.include_sensitive_fields ?? false,
        traffic_source: input.traffic_source ?? "platform",
        subscribed_events: input.subscribed_events.map((name) => ({ name })),
        endpoint_secret_key: `pdl_ntfset_fake_${randomBytes(12).toString("hex")}`,
      };
      notificationSettings.set(setting.id, setting);
      return setting;
    },

    removeNotificationSetting(settingId: string): void {
      get(notificationSettings, settingId);
      notificationSettings.delete(settingId);
    },

    addPortalSession(
      customerId: string,
      subscriptionIds: string[],
    ): FakeEntity {
      if (!customers.has(customerId)) throw notFound(customerId);
      const token = randomBytes(8).toString("hex");
      const owned = subscriptionIds.map((id) => {
        const subscription = get(subscriptions, id);
        if (subscription.customer_id !== customerId) throw notFound(id);
        return {
          id,
          cancel_subscription: `https://portal.example.test/cancel?token=${token}`,
          update_subscription_payment_method: `https://portal.example.test/payment-method?token=${token}`,
        };
      });
      return {
        id: fakeId("cpls"),
        customer_id: customerId,
        urls: {
          general: {
            overview: `https://portal.example.test/overview?token=${token}`,
          },
          subscriptions: owned,
        },
        created_at: timestamp(),
      };
    },

    reset(): void {
      products.clear();
      prices.clear();
      transactions.clear();
      subscriptions.clear();
      customers.clear();
      notificationSettings.clear();
      this.listWithSecrets = true;
      this.notificationListPageSize = null;
    },
  };
}

function addNegative(from: Date, cycle: Cycle): Date {
  return addCycle(from, {
    interval: cycle.interval,
    frequency: -cycle.frequency,
  });
}
