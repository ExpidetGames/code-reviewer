// SPDX-License-Identifier: Apache-2.0

// The address a project pins for its catalog provider (#588, needs a security review). The catalog's address is trusted on first
// sight (#548); what a project does with its own key is held to the address it saw when it selected the provider. Pure: the
// service reads the catalog and the storage and asks these functions what to store and what to show.
//
// The rule of the pin, one place:
//   - a provider outside the catalog (the registry's, or none) has no pin; the registry's address is in the code;
//   - selecting a catalog provider pins the address the catalog trusts at that moment, once;
//   - nothing else moves the pin: a save that does not select a provider keeps it, whatever the catalog trusts now;
//   - the person confirming the address (`confirmProviderAddress`) pins what the catalog trusts now;
//   - a selection made before pins existed has none; the first claim adopts the address it is about to send the key to.
// Who may move it: writing a pin that another project of the workspace does not hold, and dropping or replacing a pin the catalog
// no longer trusts, are reserved to the roles that manage the workspace's LLM key (`pinMoveNeedsRight`); anyone else is refused.
// A claim refuses a job whose catalog trusts another address than the pin (`provider_address_changed`) before it loads a key.

/** What the service knows when a project save decides the pin. */
export type PinInput = {
  /** The Dynamic provider the project has after the save. */
  nextProvider: string | undefined;
  /** The Dynamic provider the project had before the save. */
  storedProvider: string | undefined;
  /** The pin the project had before the save. */
  storedPin: string | undefined;
  /** Whether the provider after the save is a catalog provider (`isNativeProvider`). */
  native: boolean;
  /** The address the catalog trusts for it now; undefined when it is not offered. */
  trusted: string | undefined;
  /** The person confirmed the address in this request. */
  confirm: boolean;
};

/** The pin a project has after a save, or undefined for none. */
export function pinAfterSave(input: PinInput): string | undefined {
  if (!input.native || input.nextProvider === undefined) return undefined;
  if (input.confirm) return input.trusted;
  if (input.nextProvider !== input.storedProvider) return input.trusted;
  return input.storedPin ?? input.trusted;
}

/** What decides whether a save moves the pin in a way only an Owner or Admin may. */
export type PinMove = {
  /** The pin the project had before the save. */
  storedPin: string | undefined;
  /** The pin the project has after the save. */
  newPin: string | undefined;
  /** The address the catalog trusts now for the provider the project had before the save; undefined when it trusts none. */
  trustedForStored: string | undefined;
  /** The pins the other projects of the workspace hold for the provider the project has after the save. */
  otherPins: readonly string[];
};

/**
 * Whether a save needs the right to manage the workspace's LLM key (#588): it drops or replaces a pin that is not the address the
 * catalog trusts now (a Member could otherwise walk the pin to a moved address by confirming, by choosing another provider and
 * back, or by a reset), or it writes a pin that differs from one another project of the workspace holds for the provider (the
 * first pin of a provider, with no other, is the first sight and needs no right). A save that leaves the pin as it is needs none.
 */
export function pinMoveNeedsRight(move: PinMove): boolean {
  if (move.newPin === move.storedPin) return false;
  if (move.storedPin !== undefined && move.storedPin !== move.trustedForStored)
    return true;
  return (
    move.newPin !== undefined &&
    move.otherPins.some((pin) => pin !== move.newPin)
  );
}

/** How the pinned address compares with what the catalog trusts now, for the settings page. */
export const PROVIDER_ADDRESS_STATES = [
  /** The pin is the trusted address. */
  "pinned",
  /** A selection from before pins: the first review pins the trusted address. */
  "unpinned",
  /** The catalog trusts another address now: reviews are refused until an Owner or Admin confirms it. */
  "changed",
  /** The catalog trusts no address for the provider now (blocked or gone). */
  "unavailable",
] as const;
export type ProviderAddressState = (typeof PROVIDER_ADDRESS_STATES)[number];

export type ProviderAddressView = {
  pinned: string | null;
  current: string | null;
  state: ProviderAddressState;
};

export function providerAddressView(
  pinned: string | undefined,
  current: string | undefined,
): ProviderAddressView {
  const view = { pinned: pinned ?? null, current: current ?? null };
  if (current === undefined) return { ...view, state: "unavailable" };
  if (pinned === undefined) return { ...view, state: "unpinned" };
  return { ...view, state: pinned === current ? "pinned" : "changed" };
}
