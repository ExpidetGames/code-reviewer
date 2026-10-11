// A section that a later issue fills (mail, integrations): a heading and a sentence on what will be here.
import { EmptyState } from "../../ui/empty-state.tsx";

export function Placeholder({
  title,
  children,
}: {
  title: string;
  children: string;
}) {
  return <EmptyState title={title}>{children}</EmptyState>;
}
