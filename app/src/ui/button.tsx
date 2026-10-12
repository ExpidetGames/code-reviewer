// SPDX-License-Identifier: Apache-2.0

// Buttons are plain elements with the classes `btn btn-<variant>` (see globals.css).
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export function Button({
  variant = "primary",
  type = "button",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const classes = ["btn", `btn-${variant}`, className]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={classes} {...props} />;
}
