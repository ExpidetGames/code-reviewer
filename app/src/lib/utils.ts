// SPDX-License-Identifier: Apache-2.0

// The class name helper of the shadcn/ui components: `clsx` joins conditional class names and
// `tailwind-merge` removes the earlier one when two Tailwind utilities touch the same property, so
// a component's default classes can be overridden by the caller's `className`.
// Adapted from shadcn/ui (https://ui.shadcn.com), whose `cn` helper this follows. It stays
// Apache-2.0: it is a two-line composition, not a copied component (CONTRIBUTING.md, "License").
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
