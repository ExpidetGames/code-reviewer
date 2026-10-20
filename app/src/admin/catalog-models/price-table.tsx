// SPDX-License-Identifier: Apache-2.0

// A price book as a table (#554): every amount the book states in dollars per million tokens, with where it comes from
// (models.dev, the override file or an admin's correction), so an admin reads what they are about to confirm. A field the
// book does not price is not a row ("not priced" is not zero). The tier rows say the context size and the prices of the tier.
import { Badge } from "../../components/ui/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import type { PriceSources } from "../../model-prices/effective-price.ts";
import type {
  PriceBookJson,
  PriceLevelJson,
} from "../../model-prices/price-book.ts";
import { formatUsdPerMTok } from "./format.ts";
import { PRICE_FIELD_LABEL, PRICE_SOURCE_LABEL } from "./messages.ts";
import { LEVEL_FIELDS, type LevelField } from "./price-form.ts";

const SHORT_LABEL: Record<LevelField, string> = {
  input: "Input",
  output: "Output",
  cacheRead: "Cache read",
  cacheWrite5m: "Cache write 5 min",
  cacheWrite1h: "Cache write 1 h",
  reasoning: "Reasoning",
  inputAudio: "Audio in",
  outputAudio: "Audio out",
};

/** "Input $5.00 · Output $22.50": the prices a level states. */
export function levelSummary(level: PriceLevelJson): string {
  return LEVEL_FIELDS.flatMap((field) => {
    const amount = level[field];
    return amount === null
      ? []
      : [`${SHORT_LABEL[field]} ${formatUsdPerMTok(amount)}`];
  }).join(" · ");
}

function SourceBadge({ source }: { source: PriceSources[keyof PriceSources] }) {
  if (source === null) return null;
  return (
    <Badge variant={source === "admin" ? "warning" : "neutral"}>
      {PRICE_SOURCE_LABEL[source]}
    </Badge>
  );
}

export function PriceTable({
  book,
  sources,
  label,
}: {
  book: PriceBookJson;
  sources: PriceSources | null;
  /** Names the table for assistive technology and tells two tables of one dialog apart. */
  label: string;
}) {
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead>Price</TableHead>
          <TableHead>Per million tokens</TableHead>
          <TableHead>Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {LEVEL_FIELDS.filter((field) => book[field] !== null).map((field) => (
          <TableRow key={field}>
            <TableCell>{PRICE_FIELD_LABEL[field]}</TableCell>
            <TableCell className="font-mono">
              {formatUsdPerMTok(book[field] ?? "")}
            </TableCell>
            <TableCell>
              <SourceBadge source={sources?.[field] ?? null} />
            </TableCell>
          </TableRow>
        ))}
        {book.contextOver200k === null ? null : (
          <TableRow>
            <TableCell>{PRICE_FIELD_LABEL.contextOver200k}</TableCell>
            <TableCell>{levelSummary(book.contextOver200k)}</TableCell>
            <TableCell>
              <SourceBadge source={sources?.contextOver200k ?? null} />
            </TableCell>
          </TableRow>
        )}
        {book.tiers.map((tier) => (
          <TableRow key={tier.contextOver}>
            <TableCell>{`Above ${String(tier.contextOver)} tokens`}</TableCell>
            <TableCell>{levelSummary(tier)}</TableCell>
            <TableCell>
              <SourceBadge source={sources?.tiers ?? null} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
