"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "@/components/ui/WalletButton";
import { CreatorActivityNotifications } from "@/components/insights/CreatorActivityNotifications";

const VotumMark = () => (
  <>
    <span className="w-5 h-5 bg-signal-gold rounded-full flex-shrink-0" />
    <span className="font-display text-ballot-ink font-medium text-body-lg hidden sm:inline">
      Votum
    </span>
  </>
);

interface NavLink {
  label: string;
  href: string;
}

const navLinks: NavLink[] = [
  { label: "Explore", href: "/explore" },
  { label: "Create", href: "/create" },
  { label: "How it works", href: "/how-it-works" },
  { label: "My Polls", href: "/my-polls" },
  { label: "Drafts", href: "/drafts" },
  { label: "Insights", href: "/insights" },
];

export function ProductNav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Close on route change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMenuOpen(false);
  }, [pathname]);

  // Close on escape
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [menuOpen, closeMenu]);

  // Lock body scroll when menu open
  useEffect(() => {
    if (menuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <nav
        className="bg-clear-ballot border-b border-divider h-14 flex items-center px-4 gap-2 relative z-40"
        role="navigation"
        aria-label="Product navigation"
      >
        {/* Left: brand */}
        <Link
          href="/"
          className="min-h-[44px] min-w-[44px] flex items-center gap-2 flex-shrink-0"
          aria-label="Votum home"
        >
          <VotumMark />
        </Link>

        {/* Center: desktop nav pills (hidden on mobile/tablet) */}
        <div className="hidden lg:flex flex-1 items-center justify-center gap-1">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`min-h-[44px] min-w-[44px] flex items-center justify-center px-3 text-sm font-medium transition-colors rounded-full ${
                isActive(link.href)
                  ? "bg-signal-gold text-ballot-ink"
                  : "text-quiet-ink hover:text-ballot-ink hover:bg-soft-fog"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>

        {/* Right: notifications + wallet + hamburger */}
        <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
          <CreatorActivityNotifications />
          <div className="hidden lg:block">
            <WalletButton />
          </div>

          {/* Hamburger (mobile/tablet only) */}
          <button
            type="button"
            onClick={() => setMenuOpen((prev) => !prev)}
            className="lg:hidden min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-ballot-ink hover:bg-soft-fog transition-colors"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
          >
            {menuOpen ? (
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M5 5L15 15M15 5L5 15"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M3 6H17M3 10H17M3 14H17"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>
      </nav>

      {/* Mobile menu overlay */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-ballot-ink/20 backdrop-blur-sm"
            onClick={closeMenu}
            aria-hidden="true"
          />

          {/* Drawer */}
          <div className="absolute top-14 left-0 right-0 bg-clear-ballot border-b border-divider shadow-card">
            <div className="px-4 py-3 space-y-1">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={closeMenu}
                  className={`flex items-center min-h-[48px] px-4 rounded-full text-body font-medium transition-colors ${
                    isActive(link.href)
                      ? "bg-signal-gold text-ballot-ink"
                      : "text-ballot-ink hover:bg-soft-fog"
                  }`}
                >
                  {link.label}
                </Link>
              ))}
            </div>
            <div className="px-4 py-3 border-t border-divider">
              <WalletButton />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
