// SPDX-License-Identifier: LicenseRef-Proprietary

// The filters of the catalog page (#554): a plain GET form, so the filters are in the address, work without script and
// are reached with the keyboard. The provider select lists every provider of the catalog (about two hundred), which a
// native select handles; the list of models itself is paged on the server.
import Link from "next/link";
import { buttonVariants } from "../../components/ui/button.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import type { ProviderView } from "../../models-dev/admin-service.ts";
import { truncateText } from "./format.ts";
import {
  MODEL_STATE_LABEL,
  PRICE_STATUS_LABEL,
  PRICE_STATUS_ORDER,
} from "./messages.ts";
import {
  CATALOG_PATH,
  STATE_FILTERS,
  catalogHref,
  type CatalogQuery,
} from "./query.ts";
import { cn } from "../../lib/utils.ts";

const SELECT_CLASS =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function CatalogFilters({
  providers,
  query,
  newCount,
}: {
  providers: readonly ProviderView[];
  query: CatalogQuery;
  /** How many models of the whole catalog are new: the badge on the link. */
  newCount: number;
}) {
  const filtered =
    query.provider !== undefined ||
    query.search !== undefined ||
    query.priceStatus !== undefined ||
    query.state !== undefined;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={catalogHref({ state: "new", page: 1 })}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          aria-current={query.state === "new" ? "page" : undefined}
        >
          New models
          <Badge variant={newCount > 0 ? "info" : "neutral"}>
            {String(newCount)}
          </Badge>
        </Link>
      </div>
      <form
        method="get"
        action={CATALOG_PATH}
        role="search"
        aria-label="Filter the catalog"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_2fr_1fr_1fr_auto]"
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="catalog-search">Search</Label>
          <Input
            id="catalog-search"
            name="q"
            type="search"
            defaultValue={query.search ?? ""}
            maxLength={200}
            autoComplete="off"
            placeholder="Name or id"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="catalog-provider">Provider</Label>
          <select
            id="catalog-provider"
            name="provider"
            defaultValue={query.provider ?? ""}
            className={SELECT_CLASS}
          >
            <option value="">All providers</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {truncateText(provider.name, 60).text}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="catalog-price">Price status</Label>
          <select
            id="catalog-price"
            name="price"
            defaultValue={query.priceStatus ?? ""}
            className={SELECT_CLASS}
          >
            <option value="">Any</option>
            {PRICE_STATUS_ORDER.map((status) => (
              <option key={status} value={status}>
                {PRICE_STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="catalog-state">State</Label>
          <select
            id="catalog-state"
            name="state"
            defaultValue={query.state ?? ""}
            className={SELECT_CLASS}
          >
            <option value="">Any</option>
            {STATE_FILTERS.map((state) => (
              <option key={state} value={state}>
                {MODEL_STATE_LABEL[state]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className={cn(
              buttonVariants({ variant: "default", size: "default" }),
            )}
          >
            Apply filters
          </button>
          {filtered ? (
            <Link
              href={CATALOG_PATH}
              className={cn(
                buttonVariants({ variant: "ghost", size: "default" }),
              )}
            >
              Clear
            </Link>
          ) : null}
        </div>
      </form>
    </div>
  );
}
