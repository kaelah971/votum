"use client";

import type { ReactNode } from "react";

interface IconButtonProps {
  label: string;
  children: ReactNode;
  size?: "sm" | "md";
  className?: string;
  onClick?: () => void;
}

const sizeClasses: Record<NonNullable<IconButtonProps["size"]>, string> = {
  sm: "w-8 h-8",
  md: "w-10 h-10",
};

export function IconButton({
  label,
  children,
  size = "md",
  className = "",
  onClick,
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`inline-flex items-center justify-center rounded-full bg-soft-fog border border-border hover:bg-black/[0.02] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2 ${sizeClasses[size]} ${className}`}
    >
      {children}
    </button>
  );
}
