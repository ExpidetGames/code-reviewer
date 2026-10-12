// SPDX-License-Identifier: Apache-2.0

// The configuration hints at the top of the pages: one alert per problem, nothing at all while the
// configuration is complete. The text comes from `describeConfigNotices`, so it names variables (for the
// instance admin only) and never values.
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
