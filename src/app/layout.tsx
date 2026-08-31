import type { Metadata, Viewport } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import { ClientProviders } from "@/providers/ClientProviders";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#EDEDED",
};

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "https://votum-five.vercel.app",
  ),
  title: {
    default: "Votum — Verified community decisions",
    template: "%s | Votum",
  },
  description:
    "Create a free verified poll or fund a reward for eligible participants. Every verified wallet gets one vote.",
  openGraph: {
    title: "Votum — Verified community decisions",
    description:
      "Verified decisions. Rewards when participation is funded.",
    siteName: "Votum",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Votum — Verified community decisions",
    description:
      "Create free verified polls and discover funded participation rewards.",
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      suppressHydrationWarning
      lang="en"
      className={`${inter.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-body">
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  );
}
