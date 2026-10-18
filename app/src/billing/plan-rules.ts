// SPDX-License-Identifier: Apache-2.0

// The rules for what a plan may hold (#438, ADR 0005, 2.11), pure: no database, no clock but the one passed in. The
// input is untrusted client data; a refusal carries a stable code (`plan-errors.ts`) and the field it concerns. The
// terms of a version are checked by the same validation as the entitlements they will write (`validateEntitlements`),
// so a version can only hold what an entitlement can hold. Money is an integer in minor units; where the text of a
// price becomes one is `src/admin/ui/plan-money.ts`.
import "server-only";
import {
  PLAN_KINDS,
  type PlanKind,
  type PlanMetadata,
  type PlanTerms,
} from "../admin/ui/plans-view.ts";
import { KEY_MODES } from "../workspaces/entitlements.ts";
import {
  isValidPlanLabel,
  validateEntitlements,
} from "../workspaces/entitlements-validation.ts";
import { planEntitlements } from "./plan-entitlements.ts";
import type { PlanRefusal } from "./plan-errors.ts";

export type Checked<T> =
  ({ ok: true } & { value: T }) | ({ ok: false } & PlanRefusal);

export const PLAN_DESCRIPTION_MAX_LENGTH = 400;
export const PLAN_SORT_MAX = 100_000;
export const CONTACT_TARGET_MAX_LENGTH = 2048;
const PLAN_KEY = /^[a-z][a-z0-9-]{1,31}$/;
const CONTROL_OR_SPACE = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
const MAIL_ADDRESS =
  /^mailto:[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

function refuse(code: PlanRefusal["code"], field?: string): Checked<never> {
  return field === undefined ? { ok: false, code } : { ok: false, code, field };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(
  input: Record<string, unknown>,
  known: readonly string[],
): string | undefined {
  return Object.keys(input).find((key) => !known.includes(key));
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * A contact target is what the Enterprise "Contact us" button opens: an https link without credentials, or a `mailto:`
 * address without a query. Nothing else (`javascript:`, `data:`, plain http, a relative link) can be saved.
 */
function isContactTarget(text: string): boolean {
  if (text.length === 0 || text.length > CONTACT_TARGET_MAX_LENGTH)
    return false;
  if (CONTROL_OR_SPACE.test(text)) return false;
  if (text.startsWith("mailto:")) return MAIL_ADDRESS.test(text);
  try {
    const url = new URL(text);
    return (
      url.protocol === "https:" &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

const METADATA_KEYS = [
  "name",
  "description",
  "sort",
  "offered",
  "popular",
  "contactTarget",
] as const;

/**
 * The fields edited in place. The whole set is given (a caller that changes one field merges it into the stored
 * ones first); a field it does not know is refused.
 */
export function validatePlanMetadata(
  kind: PlanKind,
  input: unknown,
): Checked<PlanMetadata> {
  if (!isRecord(input)) return refuse("plan_input_invalid");
  const unknown = unknownKey(input, METADATA_KEYS);
  if (unknown !== undefined) return refuse("plan_input_invalid", unknown);

  const { name, description, sort, offered, popular } = input;
  const contactTarget = input.contactTarget ?? null;
  if (!isValidPlanLabel(name)) return refuse("plan_name_invalid", "name");
  if (
    typeof description !== "string" ||
    [...description].length > PLAN_DESCRIPTION_MAX_LENGTH ||
    CONTROL.test(description)
  )
    return refuse("plan_description_invalid", "description");
  if (
    typeof sort !== "number" ||
    !Number.isInteger(sort) ||
    sort < 0 ||
    sort > PLAN_SORT_MAX
  )
    return refuse("plan_sort_invalid", "sort");
  if (typeof offered !== "boolean")
    return refuse("plan_input_invalid", "offered");
  if (typeof popular !== "boolean")
    return refuse("plan_input_invalid", "popular");
  if (popular && kind !== "paid")
    return refuse("popular_requires_paid_plan", "popular");

  if (kind !== "contact") {
    if (contactTarget !== null)
      return refuse("contact_target_not_allowed", "contactTarget");
  } else if (contactTarget === null) {
    if (offered) return refuse("contact_target_required", "contactTarget");
  } else if (
    typeof contactTarget !== "string" ||
    !isContactTarget(contactTarget)
  )
    return refuse("contact_target_invalid", "contactTarget");

  return {
    ok: true,
    value: { name, description, sort, offered, popular, contactTarget },
  };
}

const TERMS_KEYS = [
  "keyMode",
  "limits",
  "modelAccess",
  "monthlyAmountMinor",
  "yearlyAmountMinor",
] as const;

function checkPrices(
  kind: PlanKind,
  input: Record<string, unknown>,
):
  | { ok: true; monthly: number | null; yearly: number | null }
  | ({ ok: false } & PlanRefusal) {
  const monthly = input.monthlyAmountMinor ?? null;
  const yearly = input.yearlyAmountMinor ?? null;
  if (kind !== "paid") {
    if (monthly !== null)
      return {
        ok: false,
        code: "plan_price_not_allowed",
        field: "monthlyAmountMinor",
      };
    if (yearly !== null)
      return {
        ok: false,
        code: "plan_price_not_allowed",
        field: "yearlyAmountMinor",
      };
    return { ok: true, monthly: null, yearly: null };
  }
  if (!isPrice(monthly))
    return {
      ok: false,
      code: "plan_price_invalid",
      field: "monthlyAmountMinor",
    };
  if (yearly !== null && !isPrice(yearly))
    return {
      ok: false,
      code: "plan_price_invalid",
      field: "yearlyAmountMinor",
    };
  return { ok: true, monthly, yearly };
}

/**
 * The terms of one version of a plan of `kind`, from client input. The order of the checks: the key mode and whether
 * the kind can have it, whether the kind has versions at all, the model access for the key mode, the prices, then
 * the limits and the model access shape by the entitlements validation.
 */
export function validatePlanTerms(
  kind: PlanKind,
  input: unknown,
  context: { planName: string; now: Date },
): Checked<PlanTerms> {
  if (!isRecord(input)) return refuse("plan_input_invalid", "terms");
  const unknown = unknownKey(input, TERMS_KEYS);
  if (unknown !== undefined) return refuse("plan_input_invalid", unknown);

  const keyMode = KEY_MODES.find((mode) => mode === input.keyMode);
  if (keyMode === undefined) return refuse("plan_key_mode_invalid", "keyMode");
  if (keyMode === "own" && kind === "free")
    return refuse("free_plan_key_mode_fixed", "keyMode");
  if (keyMode === "own" && kind !== "paid")
    return refuse("own_plan_requires_paid_plan", "keyMode");
  if (kind === "contact") return refuse("contact_plan_has_no_versions");

  const given = input.modelAccess ?? null;
  if (keyMode === "own" && given !== null)
    return refuse("model_access_requires_managed_plan", "modelAccess");
  if (keyMode === "managed" && given === null)
    return refuse("catalog_entry_invalid", "modelAccess");

  const prices = checkPrices(kind, input);
  if (!prices.ok) return prices;

  // The same validation as the operator API's: the limits, the cost limit next to the own key and the shape of the
  // list. `modelAccess` of an own version is not in the payload (the write states `null`: every released entry).
  const checked = validateEntitlements(
    {
      planLabel: context.planName,
      keyMode,
      limits: input.limits,
      periodStart: context.now.toISOString(),
      suspended: false,
      suspensionCode: null,
      modelAccess: keyMode === "own" ? { catalogEntries: null } : given,
    },
    context.now,
  );
  if (!checked.ok) return refuse(checked.code, checked.field);

  const terms: PlanTerms = {
    keyMode,
    limits: checked.value.limits,
    modelAccess: keyMode === "own" ? null : (checked.value.modelAccess ?? null),
    monthlyAmountMinor: prices.monthly,
    yearlyAmountMinor: prices.yearly,
  };
  // The writer's own guard, so a terms object that passes here can be written.
  planEntitlements({
    name: context.planName,
    terms,
    periodStart: context.now.toISOString(),
  });
  return { ok: true, value: terms };
}

export type NewPlan = {
  planKey: string;
  kind: "paid" | "contact";
  metadata: PlanMetadata;
  /** `null` for a `contact` plan. */
  terms: PlanTerms | null;
};

const NEW_PLAN_KEYS = ["planKey", "kind", "terms", ...METADATA_KEYS] as const;

/** A plan to create: only a `paid` or a `contact` plan; the one Free plan is seeded when billing is first switched on. */
export function validateNewPlan(input: unknown, now: Date): Checked<NewPlan> {
  if (!isRecord(input)) return refuse("plan_input_invalid");
  const unknown = unknownKey(input, NEW_PLAN_KEYS);
  if (unknown !== undefined) return refuse("plan_input_invalid", unknown);

  if (typeof input.planKey !== "string" || !PLAN_KEY.test(input.planKey))
    return refuse("plan_key_invalid", "planKey");
  const kind = PLAN_KINDS.find((candidate) => candidate === input.kind);
  if (kind === undefined) return refuse("plan_kind_invalid", "kind");
  const terms = input.terms ?? null;
  if (isRecord(terms) && terms.keyMode === "own" && kind !== "paid")
    return refuse("own_plan_requires_paid_plan", "keyMode");
  if (kind === "free") return refuse("plan_kind_invalid", "kind");

  const { planKey, kind: _kind, terms: _terms, ...rest } = input;
  void _kind;
  void _terms;
  const metadata = validatePlanMetadata(kind, rest);
  if (!metadata.ok) return metadata;

  if (kind === "contact") {
    if (terms !== null) return refuse("contact_plan_has_no_versions");
    return {
      ok: true,
      value: {
        planKey: planKey as string,
        kind,
        metadata: metadata.value,
        terms: null,
      },
    };
  }
  if (terms === null) return refuse("plan_input_invalid", "terms");
  const checked = validatePlanTerms("paid", terms, {
    planName: metadata.value.name,
    now,
  });
  if (!checked.ok) return checked;
  return {
    ok: true,
    value: {
      planKey: planKey as string,
      kind,
      metadata: metadata.value,
      terms: checked.value,
    },
  };
}
