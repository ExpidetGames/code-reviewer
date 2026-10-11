// SPDX-License-Identifier: Apache-2.0

// "Last changed by ada@example.com on 2026-10-11 09:00 UTC", under a setting: who and when, as the
// settings service recorded it. A setting that was never changed says so.
import { formatUtc } from "../../ui/format-time.ts";
import type { SettingView } from "../service.ts";

export function LastChanged({ setting }: { setting: SettingView<unknown> }) {
  if (setting.updatedAt === null)
    return <p className="muted small">Never changed: the default is in use.</p>;
  const who =
    setting.updatedBy === null
      ? "the system"
      : (setting.updatedBy.email ?? "a user who was deleted since");
  return (
    <p className="muted small">
      Last changed by {who} on {formatUtc(setting.updatedAt)}.
    </p>
  );
}
