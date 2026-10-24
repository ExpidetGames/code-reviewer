// SPDX-License-Identifier: LicenseRef-Proprietary

// A section that a later issue fills (mail, integrations): a heading and a sentence on what will be
// here. On the component kit (#185): the shadcn `Empty` block instead of the deleted legacy wrapper,
// with the title as an `<h2>` so the section is reachable by heading (R61).
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";

export function Placeholder({
  title,
  children,
}: {
  title: string;
  children: string;
}) {
  return (
    <section aria-label={title}>
      <Empty>
        <EmptyHeader>
          <h2 className="text-lg font-medium tracking-tight">{title}</h2>
          <EmptyDescription>{children}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  );
}
