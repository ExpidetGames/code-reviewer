// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The capability set of the deployment for client components (the sidebar, the settings navigation, the admin menu). The root
// layout reads it on the server and hands the list down; a client component asks `useCapabilities()`. Without a provider (a
// component rendered alone in a test) the answer is the whole product of code-review.com.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  createCapabilitySet,
  type Capability,
  type CapabilitySet,
} from "./capability.ts";
import { PRODUCTS } from "./products.ts";

const WHOLE_PRODUCT = createCapabilitySet(PRODUCTS["code-review-com"].default);

const CapabilitiesContext = createContext<readonly Capability[] | null>(null);

export function CapabilitiesProvider({
  capabilities,
  children,
}: {
  capabilities: readonly Capability[];
  children: ReactNode;
}) {
  return (
    <CapabilitiesContext.Provider value={capabilities}>
      {children}
    </CapabilitiesContext.Provider>
  );
}

export function useCapabilities(): CapabilitySet {
  const provided = useContext(CapabilitiesContext);
  return useMemo(
    () => (provided === null ? WHOLE_PRODUCT : createCapabilitySet(provided)),
    [provided],
  );
}
