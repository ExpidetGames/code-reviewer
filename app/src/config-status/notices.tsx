// SPDX-License-Identifier: Apache-2.0

// The configuration hints at the top of the pages: one alert per problem, nothing at all while the
// configuration is complete. The text comes from `describeConfigNotices`, so it names variables (for the
// instance admin only) and never values.
import Link from "next/link";
import { describeConfigNotices } from "./notices.ts";
import type { ConfigAudience, ConfigStatus } from "./status.ts";

export function ConfigNotices({
  status,
  audience = "member",
}: {
  status: ConfigStatus;
  /** The instance admin reads which variables are wrong; everybody else only that a part is not set up. */
  audience?: ConfigAudience;
}) {
  const notices = describeConfigNotices(status, audience);
  if (notices.length === 0) return null;
  return (
    <section className="notices" aria-label="Configuration problems">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={`alert alert-${notice.severity}`}
          role={notice.severity === "error" ? "alert" : "status"}
        >
          <strong>{notice.title}</strong>
          <p>{notice.detail}</p>
        </div>
      ))}
    </section>
  );
}

/** One row of the "Needs attention" strip: what is wrong and where to fix it. */
export type AttentionItem = {
  id: string;
  title: string;
  /** One line the title cannot say; a longer explanation is not needed here. */
  detail?: string;
  href: string;
  /** The link's action, a verb and its object ("Open Connections"). */
  linkLabel: string;
};

/**
 * The one "Needs attention" strip of the pages that can be blocked by a configuration problem
 * (Projects, project settings, workspace settings). Nothing is rendered while there is nothing to
 * say; each row is a fact and the link that leads to the fix.
 */
export function NeedsAttention({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Needs attention"
      className="mb-6 rounded-lg border border-warning bg-warning-soft p-4 text-warning"
    >
      <h2 className="text-sm font-semibold">Needs attention</h2>
      <ul className="mt-3 flex flex-col gap-3">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-start justify-between gap-3"
          >
            <div className="min-w-0">
              <p className="font-medium">{item.title}</p>
              {item.detail ? <p className="text-sm">{item.detail}</p> : null}
            </div>
            <Link
              href={item.href}
              className="shrink-0 font-medium text-current underline underline-offset-4"
            >
              {item.linkLabel}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
