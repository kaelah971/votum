"use client";

import { NimiqProvider } from "@/providers/NimiqProvider";
import { VotumSessionProvider } from "@/providers/VotumSessionProvider";
import type { ReactNode } from "react";

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <NimiqProvider>
      <VotumSessionProvider>
        {children}
      </VotumSessionProvider>
    </NimiqProvider>
  );
}
