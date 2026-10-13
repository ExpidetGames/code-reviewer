// SPDX-License-Identifier: Apache-2.0

// A section that a later issue fills (mail, integrations): a heading and a sentence on what will be
// here. On the component kit (#185): the shadcn `Empty` block instead of the deleted legacy wrapper.
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

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
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{children}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  );
}
