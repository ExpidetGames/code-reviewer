// SPDX-License-Identifier: LicenseRef-Proprietary

// Tabs whose active tab lives in the query string, so a tab is deep-linkable, survives a reload and
// can be shared. Ours on top of the copied shadcn Tabs; the query string is the single
// source of truth, an unknown or missing value falls back to the first tab.
//
// `useSearchParams` suspends on the server; a page that renders `QueryTabs` must wrap it in a
// `<Suspense>` boundary (or the page opts into dynamic rendering), the way the legacy filter forms
// do today.
"use client";

import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type QueryTab = {
  value: string;
  label: ReactNode;
  content: ReactNode;
};

export function QueryTabs({
  items,
  param = "tab",
  "aria-label": ariaLabel,
}: {
  /** At least one tab; the first is the fallback when the query string names none. */
  items: readonly [QueryTab, ...QueryTab[]];
  /** The query-string key, `tab` by default. */
  param?: string;
  "aria-label": string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const requested = searchParams.get(param) ?? "";
  const active = items.some((item) => item.value === requested)
    ? requested
    : items[0].value;

  function selectTab(value: string): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set(param, value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <Tabs value={active} onValueChange={selectTab}>
      <TabsList aria-label={ariaLabel}>
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {items.map((item) => (
        <TabsContent key={item.value} value={item.value}>
          {item.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
