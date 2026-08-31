import type { ReactNode } from "react";
import { AppFrame } from "@/components/layout/AppFrame";
import { MarketingNav } from "@/components/layout/MarketingNav";

interface MarketingShellProps {
  children: ReactNode;
}

export function MarketingShell({ children }: MarketingShellProps) {
  return (
    <AppFrame>
      <MarketingNav />
      <main className="flex-1 px-5 pb-6 pt-4 sm:px-8 md:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-[1180px]">{children}</div>
      </main>
      <footer className="px-5 pb-8 pt-4 text-center text-micro text-quiet-ink">
        Votum &middot; Verified community decisions
      </footer>
    </AppFrame>
  );
}
