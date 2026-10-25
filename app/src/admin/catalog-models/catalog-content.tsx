// SPDX-License-Identifier: LicenseRef-Proprietary

// The catalog page of the admin portal (#554): the state of the daily fetch with "Fetch now", the providers whose address
// needs a decision, the filters, and one page of the models with their state, price status and actions. The catalog is
// empty until the first fetch; then the page says so and offers the fetch. Admin only: it names providers, models and
// prices, none of which a member of a workspace ever sees.
import Link from "next/link";
import { Breadcrumbs } from "../../components/breadcrumbs.tsx";
import { PageHeader } from "../../components/page-header.tsx";
import { buttonVariants } from "../../components/ui/button.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "../../components/ui/empty.tsx";
import { cn } from "../../lib/utils.ts";
import type { ModelList } from "../../model-prices/service.ts";
import type { ProviderList } from "../../models-dev/admin-service.ts";
import { CatalogFilters } from "./filters.tsx";
import { FetchPanel } from "./fetch-panel.tsx";
import { ModelsTable } from "./models-table.tsx";
import { ProvidersPanel } from "./providers-panel.tsx";
import { PAGE_SIZE, catalogHref, type CatalogQuery } from "./query.ts";

export function AdminCatalogContent({
  list,
  providers,
  query,
}: {
  list: ModelList;
  providers: ProviderList;
  query: CatalogQuery;
}) {
  const filtered =
    query.provider !== undefined ||
    query.search !== undefined ||
    query.priceStatus !== undefined ||
    query.state !== undefined;
  const empty =
    providers.providers.length === 0 && list.total === 0 && !filtered;
  const first = (query.page - 1) * PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const blocked = providers.providers.filter((p) => p.url.state !== "trusted");
  return (
    <div data-slot="admin-catalog" className="flex flex-col gap-6">
      <PageHeader
        title="models.dev catalog"
        description="The providers and models of models.dev. Enable the ones members may use on the managed key, and confirm what each costs us first."
        breadcrumb={
          <Breadcrumbs
            items={[{ label: "Admin", href: "/admin" }, { label: "Catalog" }]}
          />
        }
      />
      <FetchPanel fetch={list.fetch} fetchEnabled={providers.fetchEnabled} />
      <ProvidersPanel providers={blocked} />
      {empty ? (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              The catalog is empty. It is filled by the first fetch.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <CatalogFilters
            providers={providers.providers}
            query={query}
            newCount={list.newCount}
          />
          {list.models.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyDescription>
                  {list.total > 0
                    ? "This page is past the end of the list."
                    : "No model matches these filters."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ModelsTable models={list.models} />
          )}
          <nav
            aria-label="Pages of the catalog"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {list.total === 0
                ? "0 models"
                : `Showing ${String(first + Math.min(1, list.models.length))}–${String(first + list.models.length)} of ${String(list.total)} models`}
            </p>
            <div className="flex gap-2">
              {query.page > 1 ? (
                <Link
                  rel="prev"
                  href={catalogHref({ ...query, page: query.page - 1 })}
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                  )}
                >
                  Previous page
                </Link>
              ) : null}
              {query.page < pages ? (
                <Link
                  rel="next"
                  href={catalogHref({ ...query, page: query.page + 1 })}
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                  )}
                >
                  Next page
                </Link>
              ) : null}
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
