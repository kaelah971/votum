import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  glass?: boolean;
}

export function Card({ children, className = "", glass = false }: CardProps) {
  return (
    <div
      className={`rounded-card border border-white/75 ${
        glass
          ? "bg-clear-ballot/68 shadow-[0_16px_48px_rgba(24,32,29,0.06)] backdrop-blur"
          : "bg-clear-ballot shadow-card"
      } ${className}`}
    >
      {children}
    </div>
  );
}
