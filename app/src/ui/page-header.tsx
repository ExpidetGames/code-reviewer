// SPDX-License-Identifier: Apache-2.0

// The heading block of the pre-redesign screens. It now renders the application PageHeader
// (`@/components/page-header`) and keeps its public props, so a screen that has not moved yet still
// compiles. Each screen issue deletes this wrapper once its last usage is gone (epic #165).
import type { ReactNode } from "react";
import { PageHeader as KitPageHeader } from "@/components/page-header";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <KitPageHeader title={title} description={description} actions={actions} />
  );
}
