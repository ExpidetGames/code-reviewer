// SPDX-License-Identifier: Apache-2.0

// What a list shows while it has nothing to list: a short title, one sentence on what will appear
// here, and optionally a next step.
import type { ReactNode } from "react";

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
    <section className="empty-state" aria-label={title}>
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {action}
    </section>
  );
}
