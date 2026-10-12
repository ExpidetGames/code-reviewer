// SPDX-License-Identifier: Apache-2.0

// The empty list message of the pre-redesign screens. It now renders the shadcn Empty primitives and
// keeps its public props (a title, one sentence, an optional action), so a screen that has not moved
// yet still compiles. Each screen issue deletes this wrapper once its last usage is gone (epic
// #165).
import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "@/components/ui/empty";

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <Empty>
        <EmptyHeader>
          {/* A real heading, not just a styled `<div>`: the page keeps a heading structure. */}
          <h2 className="text-lg font-medium tracking-tight">{title}</h2>
          {children ? <EmptyDescription>{children}</EmptyDescription> : null}
        </EmptyHeader>
        {action ? <EmptyContent>{action}</EmptyContent> : null}
      </Empty>
    </section>
  );
}
