import type { ReactNode } from "react";

interface AppFrameProps {
  children: ReactNode;
  className?: string;
}

export function AppFrame({ children, className = "" }: AppFrameProps) {
  return (
    <div className="min-h-full bg-soft-fog px-3 py-3 sm:px-6 sm:py-8 lg:px-8 lg:py-12">
      <div
        className={`mx-auto flex min-h-[calc(100vh-24px)] w-full max-w-[1320px] flex-col overflow-hidden rounded-[28px] border border-white/70 bg-[#f5f5f2]/72 shadow-[0_24px_80px_rgba(24,32,29,0.07)] backdrop-blur md:min-h-[calc(100vh-64px)] ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

