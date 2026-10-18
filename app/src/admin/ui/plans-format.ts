// SPDX-License-Identifier: Apache-2.0

// The plans form in plain functions (#438): the typed text of the terms of a version becomes the terms the server
// takes, and the other way round, and the words the page uses for a limit, an amount and a model access. Pure, so the
// form and its tests share them. The server judges every value again (`src/billing/plan-rules.ts`); this only keeps a
// typo from becoming a request. "Unlimited" is an empty field, not a number: no limit and no amount is a constant here.
import {
  formatMicroAsUsd,
  formatMinorAsUsd,
  parseUsdToMicro,
  parseUsdToMinor,
} from "./plan-money.ts";
import type {
  CatalogChoice,
  PlanKind,
  PlanMetadata,
  PlanTerms,
} from "./plans-view.ts";
import type { KeyMode, ModelAccess } from "../../workspaces/entitlements.ts";

/** What the fields of the terms hold while the admin types: text, never numbers. */
export type TermsForm = {
  keyMode: KeyMode;
  /** Empty is unlimited. */
  diffRuns: string;
  dynamicRuns: string;
  /** Dollars (up to six decimals); empty is no limit. Only a `managed` version has the operator cost limit. */
  managedCostUsd: string;
  ownKeyCostUsd: string;
  /** `managed` only: every released entry, or just `entries`. */
  accessAll: boolean;
  entries: string[];
  /** Dollars and cents; paid plans only. */
  monthly: string;
  yearly: string;
};

export type FormIssue = { field: string; code: string };
export type TermsFromForm =
  { ok: true; terms: PlanTerms } | { ok: false; issues: FormIssue[] };

/** A new plan's form: managed, every limit empty (unlimited), every released entry for a paid plan and none for Free. */
export function emptyTermsForm(kind: PlanKind): TermsForm {
  return {
    keyMode: "managed",
    diffRuns: "",
    dynamicRuns: "",
    managedCostUsd: "",
    ownKeyCostUsd: "",
    accessAll: kind !== "free",
    entries: [],
    monthly: "",
    yearly: "",
  };
}

const limitText = (value: number | null) =>
  value === null ? "" : String(value);
const costText = (value: number | null) =>
  value === null ? "" : formatMicroAsUsd(value);

export function termsFormFrom(terms: PlanTerms): TermsForm {
  const entries = terms.modelAccess?.catalogEntries ?? null;
  return {
    keyMode: terms.keyMode,
    diffRuns: limitText(terms.limits.diffRunsPerPeriod),
    dynamicRuns: limitText(terms.limits.dynamicRunsPerPeriod),
    managedCostUsd: costText(terms.limits.managedCostLimitMicroUsd),
    ownKeyCostUsd: costText(terms.limits.ownKeyCostLimitMicroUsd),
    accessAll: entries === null,
    entries: entries === null ? [] : [...entries],
    monthly:
      terms.monthlyAmountMinor === null
        ? ""
        : formatMinorAsUsd(terms.monthlyAmountMinor),
    yearly:
      terms.yearlyAmountMinor === null
        ? ""
        : formatMinorAsUsd(terms.yearlyAmountMinor),
  };
}

const COUNT = /^\d{1,15}$/;

function parseCount(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return COUNT.test(trimmed) ? Number(trimmed) : undefined;
}

export function termsFromForm(kind: PlanKind, form: TermsForm): TermsFromForm {
  const issues: FormIssue[] = [];
  const keyMode: KeyMode = kind === "free" ? "managed" : form.keyMode;

  const diff = parseCount(form.diffRuns);
  const dynamic = parseCount(form.dynamicRuns);
  if (diff === undefined)
    issues.push({ field: "diffRunsPerPeriod", code: "limit_invalid" });
  if (dynamic === undefined)
    issues.push({ field: "dynamicRunsPerPeriod", code: "limit_invalid" });

  // The operator cost limit counts runs on the operator's key: an own version has none.
  const managedCost =
    keyMode === "own"
      ? { ok: true as const, micro: null }
      : parseUsdToMicro(form.managedCostUsd);
  const ownKeyCost = parseUsdToMicro(form.ownKeyCostUsd);
  if (!managedCost.ok)
    issues.push({ field: "managedCostLimitMicroUsd", code: "limit_invalid" });
  if (!ownKeyCost.ok)
    issues.push({ field: "ownKeyCostLimitMicroUsd", code: "limit_invalid" });

  let monthly: number | null = null;
  let yearly: number | null = null;
  if (kind === "paid") {
    const parsedMonthly = parseUsdToMinor(form.monthly);
    if (
      !parsedMonthly.ok ||
      parsedMonthly.minor === null ||
      parsedMonthly.minor <= 0
    )
      issues.push({ field: "monthlyAmountMinor", code: "plan_price_invalid" });
    else monthly = parsedMonthly.minor;
    const parsedYearly = parseUsdToMinor(form.yearly);
    if (
      !parsedYearly.ok ||
      (parsedYearly.minor !== null && parsedYearly.minor <= 0)
    )
      issues.push({ field: "yearlyAmountMinor", code: "plan_price_invalid" });
    else yearly = parsedYearly.minor;
  }

  if (
    issues.length > 0 ||
    diff === undefined ||
    dynamic === undefined ||
    !managedCost.ok ||
    !ownKeyCost.ok
  )
    return { ok: false, issues };

  const modelAccess: ModelAccess | null =
    keyMode === "own"
      ? null
      : { catalogEntries: form.accessAll ? null : [...form.entries] };
  return {
    ok: true,
    terms: {
      keyMode,
      limits: {
        diffRunsPerPeriod: diff,
        dynamicRunsPerPeriod: dynamic,
        managedCostLimitMicroUsd: managedCost.micro,
        ownKeyCostLimitMicroUsd: ownKeyCost.micro,
      },
      modelAccess,
      monthlyAmountMinor: monthly,
      yearlyAmountMinor: yearly,
    },
  };
}

export const describeLimit = (value: number | null) =>
  value === null ? "Unlimited" : String(value);

export const describePrice = (minor: number | null) =>
  minor === null ? "none" : `$${formatMinorAsUsd(minor)}`;

/** The model access of a version for the admin: the names of the entries, and a count of ids that match nothing. */
export function describeModelAccess(
  access: ModelAccess | null,
  catalog: readonly CatalogChoice[],
): string {
  if (access === null) return "Any model with the workspace's own keys";
  const listed = access.catalogEntries;
  if (listed === null) return "Every released entry";
  if (listed.length === 0) return "None";
  const names: string[] = [];
  let missing = 0;
  for (const id of listed) {
    const entry = catalog.find((candidate) => candidate.id === id);
    if (entry === undefined) missing += 1;
    else names.push(entry.name);
  }
  if (missing > 0)
    names.push(
      `${missing} ${missing === 1 ? "entry" : "entries"} that no longer exist${missing === 1 ? "s" : ""}`,
    );
  return names.join(", ");
}

/** What the display fields hold while the admin types. */
export type MetaForm = {
  /** Only a new plan has one; it is chosen once. */
  planKey: string;
  name: string;
  description: string;
  sort: string;
  offered: boolean;
  popular: boolean;
  contactTarget: string;
};

export function emptyMetaForm(): MetaForm {
  return {
    planKey: "",
    name: "",
    description: "",
    sort: "",
    offered: true,
    popular: false,
    contactTarget: "",
  };
}

export function metaFormFrom(
  plan: PlanMetadata & { planKey: string },
): MetaForm {
  return {
    planKey: plan.planKey,
    name: plan.name,
    description: plan.description,
    sort: String(plan.sort),
    offered: plan.offered,
    popular: plan.popular,
    contactTarget: plan.contactTarget ?? "",
  };
}

const SORT = /^\d{1,6}$/;

export type MetadataFromForm =
  { ok: true; metadata: PlanMetadata } | { ok: false; issues: FormIssue[] };

/** The display fields as the server takes them; only a Enterprise plan has a contact target. */
export function metadataFromForm(
  kind: PlanKind,
  form: MetaForm,
): MetadataFromForm {
  const sort = form.sort.trim();
  if (!SORT.test(sort))
    return {
      ok: false,
      issues: [{ field: "sort", code: "plan_sort_invalid" }],
    };
  const target = form.contactTarget.trim();
  return {
    ok: true,
    metadata: {
      name: form.name.trim(),
      description: form.description.trim(),
      sort: Number(sort),
      offered: form.offered,
      popular: kind === "paid" && form.popular,
      contactTarget: kind === "contact" && target !== "" ? target : null,
    },
  };
}
