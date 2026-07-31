import type { ReactNode } from "react";

type BadgeVariant = "default" | "signal" | "nim" | "verified" | "amber" | "reject";

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-soft-fog text-ballot-ink",
  signal: "bg-signal-gold/[0.12] text-ballot-ink",
  nim: "bg-nim-blue/[0.10] text-nim-blue",
  verified: "bg-verified-green/[0.12] text-verified-green",
  amber: "bg-fairness-amber/[0.12] text-fairness-amber",
  reject: "bg-reject-red/[0.12] text-reject-red",
};

export function Badge({
  variant = "default",
  children,
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-micro font-medium ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
