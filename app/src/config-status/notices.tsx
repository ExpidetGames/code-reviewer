// SPDX-License-Identifier: Apache-2.0

// The configuration hints at the top of the pages: one alert per problem, nothing at all while the
// configuration is complete. The text comes from `describeConfigNotices`, so it names variables and
// never values.
import { describeConfigNotices } from "./notices.ts";
import type { ConfigStatus } from "./status.ts";

export function ConfigNotices({ status }: { status: ConfigStatus }) {
  const notices = describeConfigNotices(status);
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
