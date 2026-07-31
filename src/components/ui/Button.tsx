"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";
import { CheckIcon } from "@/components/ui/icons";

type ButtonVariant = "primary" | "secondary" | "ghost" | "verified";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-signal-gold text-ballot-ink hover:bg-deep-gold",
  secondary:
    "border border-border bg-clear-ballot/55 text-ballot-ink hover:bg-clear-ballot/85",
  ghost:
    "text-ballot-ink hover:bg-clear-ballot/60",
  verified:
    "bg-verified-green text-white",
};

const sizeClasses: Record<NonNullable<ButtonProps["size"]>, string> = {
  sm: "px-4 py-2 text-sm",
  md: "px-6 py-4 text-sm",
  lg: "px-8 py-4 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      children,
      className = "",
      disabled,
      ...rest
    },
    ref,
  ) => {
    const base =
      "inline-flex items-center justify-center rounded-full font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";

    return (
      <button
        ref={ref}
        className={`${base} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
        disabled={disabled}
        {...rest}
      >
        {variant === "verified" && <CheckIcon className="mr-1.5 -ml-0.5" />}
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";
