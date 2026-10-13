// SPDX-License-Identifier: Apache-2.0

// The configuration hints at the top of the pages: one alert per problem, nothing at all while the
// configuration is complete. The text comes from `describeConfigNotices`, so it names variables (for the
// instance admin only) and never values. On the component kit (#185): the tone maps to the shadcn
// `Alert` variants, an error is the assertive role and a warning the polite one.
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
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
    <section
      className="mb-6 flex flex-col gap-3"
      aria-label="Configuration problems"
    >
      {notices.map((notice) => (
        <Alert
          key={notice.id}
          variant={notice.severity === "error" ? "destructive" : "warning"}
          role={notice.severity === "error" ? "alert" : "status"}
        >
          <AlertDescription>
            <strong>{notice.title}</strong>
            <p>{notice.detail}</p>
          </AlertDescription>
        </Alert>
      ))}
    </section>
  );
}
