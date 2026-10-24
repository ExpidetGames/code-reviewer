// SPDX-License-Identifier: LicenseRef-Proprietary

// The application Button of the redesign: a thin wrapper over the copied shadcn Button
// (`@/components/ui/button`) that narrows the public surface to this project's variants and sizes,
// adds the loading convention and enforces an accessible name on icon-only buttons.
//
// Our variants are `primary` (shadcn's `default`), `secondary`, `ghost` and `destructive`; the sizes
// are `sm`, `default` and `icon`. `icon` gets a 44px hit area (WCAG 2.5.5) and, because a picture
// alone is not a name, it must carry an `aria-label` (or `aria-labelledby`) or the render throws:
// the failure is loud on purpose, since such a button is unusable with a screen reader.
import type { ComponentProps } from "react";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/ssr";
import { Button as ShadcnButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "default" | "icon";

// Our variant name to the shadcn variant it renders.
const SHADCN_VARIANT: Record<
  ButtonVariant,
  "default" | "secondary" | "ghost" | "destructive"
> = {
  primary: "default",
  secondary: "secondary",
  ghost: "ghost",
  destructive: "destructive",
};

export type ButtonProps = Omit<
  ComponentProps<typeof ShadcnButton>,
  "variant" | "size"
> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, marks the button `aria-busy` and disables it so a double click cannot resubmit. */
  loading?: boolean;
  /** The accessible name announced while `loading` is set (for example "Saving"). */
  loadingLabel?: string;
};

export function Button({
  variant = "primary",
  size = "default",
  loading = false,
  loadingLabel,
  type = "button",
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  if (size === "icon" && !props["aria-label"] && !props["aria-labelledby"]) {
    throw new Error(
      "An icon-only Button needs an aria-label or aria-labelledby so it has an accessible name.",
    );
  }

  return (
    <ShadcnButton
      type={type}
      variant={SHADCN_VARIANT[variant]}
      size={size}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      // `size` alone is 36px; the extra class grows the icon-only hit area to 44px.
      className={cn(
        "cursor-pointer disabled:cursor-not-allowed",
        size === "icon" && "size-11",
        className,
      )}
      {...props}
    >
      {loading ? (
        <>
          <CircleNotchIcon aria-hidden="true" className="size-4 animate-spin" />
          {loadingLabel ? (
            <span className="sr-only">{loadingLabel}</span>
          ) : (
            children
          )}
        </>
      ) : (
        children
      )}
    </ShadcnButton>
  );
}
