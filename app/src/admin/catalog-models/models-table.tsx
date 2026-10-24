// SPDX-License-Identifier: LicenseRef-Proprietary

// The models of one page of the catalog (#554): name and id, the state and the warnings (with words, not only colour), the
// price with its status, the provider and what the managed key says about the model, and the actions of the row. Every
// string that comes from models.dev is untrusted: React escapes what is rendered here, nothing is set as HTML, and a long
// name or id is cut where it is shown (the full text stays in the title).
import { Badge } from "../../components/ui/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import type { CatalogModelView } from "../../model-prices/admin-view.ts";
import { formatUtc } from "../../ui/format-time.ts";
import { formatUsdPerMTok, truncateText } from "./format.ts";
import { changedPriceFields } from "./price-diff.ts";
import {
  MANAGED_REASON_COPY,
  describeChangedFields,
  MODEL_STATE_LABEL,
  MODEL_WARNING_LABEL,
  PRICE_STATUS_LABEL,
  type ModelState,
} from "./messages.ts";
import { ModelActions } from "./model-actions.tsx";
import { STATE_BADGE, STATUS_BADGE } from "./status-badges.ts";

const NAME_CHARS = 60;
const ID_CHARS = 70;

export function modelStateOf(model: CatalogModelView): ModelState {
  if (model.enabled === true) return "enabled";
  if (model.enabled === false) return "disabled";
  return model.isNew ? "new" : "undecided";
}

/** "Input $0.60 · Output $1.20" of a book, or nothing when it states no price. */
function inOut(book: CatalogModelView["price"]["book"]): string | null {
  return book === null
    ? null
    : `Input ${formatUsdPerMTok(book.input)} · Output ${formatUsdPerMTok(book.output)}`;
}

/** Where a stale price differs from the one that was confirmed; the amounts in the line above may well be the same. */
function differsText(
  confirmed: CatalogModelView["price"]["book"],
  now: CatalogModelView["price"]["book"],
): string {
  if (confirmed === null) return "";
  if (now === null) return "models.dev states no price now";
  const fields = changedPriceFields(confirmed, now);
  return fields.length === 0
    ? "No amount differs: confirm again to renew the confirmation"
    : `Differs in: ${describeChangedFields(fields)}`;
}

/** Text that is cut where it is shown; the whole of it stays available as the title. */
function Cut({
  text,
  max,
  className,
}: {
  text: string;
  max: number;
  className?: string;
}) {
  const shown = truncateText(text, max);
  return (
    <span
      className={className}
      {...(shown.cut ? { title: text } : {})}
      data-cut={shown.cut ? "true" : undefined}
    >
      {shown.text}
    </span>
  );
}

export function ModelsTable({
  models,
}: {
  models: readonly CatalogModelView[];
}) {
  return (
    <Table aria-label="Catalog models">
      <TableHeader>
        <TableRow>
          <TableHead>Model</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Price</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((model) => {
          const state = modelStateOf(model);
          const now = inOut(model.price.reference.book);
          const shown = inOut(model.price.book);
          return (
            <TableRow key={`${model.providerId}\u0000${model.modelId}`}>
              <TableCell className="max-w-[18rem] align-top">
                <div className="flex flex-col gap-1">
                  <Cut
                    text={model.name}
                    max={NAME_CHARS}
                    className="font-medium"
                  />
                  <code className="font-mono text-xs text-muted-foreground">
                    <Cut text={model.modelId} max={ID_CHARS} />
                  </code>
                  <span className="text-xs text-muted-foreground">
                    First seen{" "}
                    <time dateTime={model.firstSeenAt}>
                      {formatUtc(model.firstSeenAt)}
                    </time>
                  </span>
                </div>
              </TableCell>
              <TableCell className="align-top">
                <div className="flex flex-col items-start gap-1">
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={STATE_BADGE[state]}>
                      {MODEL_STATE_LABEL[state]}
                    </Badge>
                    {model.listed ? null : (
                      <Badge variant="warning">
                        {MODEL_WARNING_LABEL.unlisted}
                      </Badge>
                    )}
                    {model.upstreamStatus === "deprecated" ? (
                      <Badge variant="warning">
                        {MODEL_WARNING_LABEL.deprecated}
                      </Badge>
                    ) : null}
                    {model.upstreamStatus === "alpha" ? (
                      <Badge variant="neutral">
                        {MODEL_WARNING_LABEL.alpha}
                      </Badge>
                    ) : null}
                    {model.providerUrl === "trusted" ? null : (
                      <Badge variant="danger">
                        {MODEL_WARNING_LABEL.providerBlocked}
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {model.managed.selectable
                      ? "Usable on the managed key"
                      : `Not usable on the managed key: ${MANAGED_REASON_COPY[model.managed.reason]}`}
                  </span>
                </div>
              </TableCell>
              <TableCell className="align-top">
                <div className="flex flex-col items-start gap-1">
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={STATUS_BADGE[model.price.status]}>
                      {PRICE_STATUS_LABEL[model.price.status]}
                    </Badge>
                    {model.price.warnings.length > 0 ? (
                      <Badge variant="warning">Confirmation unreadable</Badge>
                    ) : null}
                  </div>
                  {model.price.status === "stale" ? (
                    <span className="text-xs">
                      <span className="text-muted-foreground">
                        You confirmed:{" "}
                      </span>
                      {shown ?? "–"}
                      <br />
                      <span className="text-muted-foreground">Now: </span>
                      {now ?? "no price"}
                      <br />
                      <span className="font-medium">
                        {differsText(
                          model.price.book,
                          model.price.reference.book,
                        )}
                      </span>
                    </span>
                  ) : (
                    <span className="text-xs">
                      {shown ?? "No price stated"}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="max-w-[12rem] align-top">
                <Cut text={model.providerName} max={40} />
              </TableCell>
              <TableCell className="align-top">
                <ModelActions model={model} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
