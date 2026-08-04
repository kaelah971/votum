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
    default: "Votum — NIM-backed community decisions",
    template: "%s | Votum",
  },
  description:
    "Put NIM behind your say. Votum helps communities make decisions with verified NIM-backed votes inside Nimiq Pay. One wallet · one vote. NIM support is counted separately.",
  openGraph: {
    title: "Votum — NIM-backed community decisions",
    description:
      "Put NIM behind your say. Create community decisions where every vote carries verified NIM-backed signal.",
    siteName: "Votum",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Votum — NIM-backed community decisions",
    description:
      "Put NIM behind your say. NIM-backed community decisions inside Nimiq Pay.",
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
