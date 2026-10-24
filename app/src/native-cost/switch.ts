// SPDX-License-Identifier: LicenseRef-Proprietary

// The switch of the native OpenCode providers (#578, design #544). Default off. The only thing it changes is whether the
// two providers of the app's registry, which keep their wires until #556, take the native path: off, `catalogRefOf` never
// names them and every claim is the claim of today; on, a Dynamic job on either carries the model entry and the cost policy
// of the catalog (the runner follows the claim: an entry present is a native job, absent is a job of today). A Diff job is
// never native. The environment of the app is the least invasive place for it: no table, no screen, no migration, and one
// line to turn off again.
import "server-only";

/** The environment variable of the app that turns the native path on. */
export const NATIVE_PROVIDERS_VARIABLE = "NATIVE_OPENCODE_PROVIDERS";

const ON = new Set(["1", "true", "on"]);

/** Whether the native path is switched on. Anything but `1`, `true` or `on` (any case) is off. */
export function nativeProvidersEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return ON.has(
    (environment[NATIVE_PROVIDERS_VARIABLE] ?? "").trim().toLowerCase(),
  );
}

/** The providers that keep their wire: the registry's while the switch is off, none once it is on. */
export function legacyProvidersFor(
  environment: Readonly<Record<string, string | undefined>>,
  registry: readonly string[],
): readonly string[] {
  return nativeProvidersEnabled(environment) ? [] : registry;
}
