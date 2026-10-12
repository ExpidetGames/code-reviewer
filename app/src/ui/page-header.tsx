// SPDX-License-Identifier: Apache-2.0

// The heading block at the top of a page: the one h1 of the page, an optional line below it and
// optional actions (buttons) on the right.
import type { ReactNode } from "react";

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
    <div className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </div>
  );
}
