// Buttons are plain elements with the classes `btn btn-<variant>` (see globals.css). `buttonClass`
// builds the class list so a link can look like a button without a second component.
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export function buttonClass(variant: ButtonVariant = "primary"): string {
  return `btn btn-${variant}`;
}

export function Button({
  variant = "primary",
  type = "button",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const classes = [buttonClass(variant), className].filter(Boolean).join(" ");
  return <button type={type} className={classes} {...props} />;
}
