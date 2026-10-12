// SPDX-License-Identifier: Apache-2.0

// The Button of the pre-redesign screens. It now renders the shadcn-based application Button
// (`@/components/button`) and keeps its public props — `variant`, a default `type="button"` and the
// rest of the `<button>` attributes — so a screen that has not moved yet still compiles. Each screen
// issue deletes this wrapper once its last usage is gone (epic #165).
import type { ButtonHTMLAttributes } from "react";
import { Button as KitButton } from "@/components/button";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export function Button({
  variant = "primary",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <KitButton variant={variant} type={type} {...props} />;
}
