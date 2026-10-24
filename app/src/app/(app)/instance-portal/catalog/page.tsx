// SPDX-License-Identifier: LicenseRef-Proprietary

// The models.dev catalog (#554): the fetch, the providers whose address needs a decision, and the models with their
// state and price, filtered and paged in the address. Instance admin only: anybody else gets the 404 of a page that does
// not exist.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { AdminCatalogContent } from "@/admin/catalog-models/catalog-content";
import { listQueryOf, parseCatalogQuery } from "@/admin/catalog-models/query";
import { getModelPriceService } from "@/model-prices/shared";
import { getModelsDevAdminService } from "@/models-dev/shared";

export const metadata: Metadata = { title: "Catalog · Admin" };

export default async function AdminCatalogPage(
  props: PageProps<"/instance-portal/catalog">,
) {
  await requireAdmin();
  const query = parseCatalogQuery(await props.searchParams);
  const [list, providers] = await Promise.all([
    getModelPriceService().list(listQueryOf(query)),
    getModelsDevAdminService().providers(),
  ]);
  return (
    <AdminCatalogContent list={list} providers={providers} query={query} />
  );
}
