import type { ReactNode } from "react";
import { AppFrame } from "@/components/layout/AppFrame";
import { ProductNav } from "@/components/layout/ProductNav";

interface ProductShellProps {
  children: ReactNode;
}

export function ProductShell({ children }: ProductShellProps) {
  return (
    <AppFrame className="max-w-[980px]">
      <ProductNav />
      <main className="flex-1 px-4 pb-8 pt-5 sm:px-8 md:px-10">
        <div className="mx-auto w-full max-w-[720px]">{children}</div>
      </main>
    </AppFrame>
  );
}
