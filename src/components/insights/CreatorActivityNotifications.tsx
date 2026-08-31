"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { Button } from "@/components/ui/Button";
import { PollTaxonomyBadges } from "@/components/product/PollTaxonomyBadges";
import { getLastSeenAt, setLastSeenAt } from "@/lib/activity/seen";
import { normalizeCategory, normalizeFormat } from "@/lib/polls/taxonomy";
import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";

interface ActivityItem {
  id: string;
  type: "poll_published" | "vote_received" | "nim_support_confirmed" | "poll_closed";
  pollId: string;
  pollQuestion: string;
  optionId?: string;
  optionLabel?: string;
  amountLuna?: string;
  occurredAt: string;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatLuna(lunaStr: string): string {
  try {
    const luna = BigInt(lunaStr);
    const LUNA_PER_NIM = BigInt(100000);
    const whole = luna / LUNA_PER_NIM;
    const frac = luna % LUNA_PER_NIM;
    if (frac === BigInt(0)) return `${whole} NIM`;
    const fracStr = frac.toString().padStart(5, "0").replace(/0+$/, "");
    return `${whole}.${fracStr} NIM`;
  } catch { return "0 NIM"; }
}

export function CreatorActivityNotifications() {
  const { isSessionVerified } = useVotumSession();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [pollTaxonomy, setPollTaxonomy] = useState<
    Map<string, { category: PollCategory; format: PollFormat }>
  >(new Map());
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const fetchActivity = useCallback(async () => {
    if (!isSessionVerified) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/me/intelligence", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const activity = (data.activity ?? []) as ActivityItem[];
      setItems(activity.slice(0, 10));

      const polls = (data.polls ?? []) as Array<{
        id: string; category?: unknown; format?: unknown;
      }>;
      const map = new Map<string, { category: PollCategory; format: PollFormat }>();
      for (const p of polls) {
        map.set(p.id, {
          category: normalizeCategory(p.category),
          format: normalizeFormat(p.format),
        });
      }
      setPollTaxonomy(map);

      const lastSeen = getLastSeenAt();
      if (lastSeen) {
        const count = activity.filter((a) => new Date(a.occurredAt).getTime() > new Date(lastSeen).getTime()).length;
        setUnreadCount(count);
      } else if (activity.length > 0) {
        setUnreadCount(activity.length);
      }
    } catch { setError("Could not load activity."); }
    finally { setLoading(false); }
  }, [isSessionVerified]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open && isSessionVerified) { fetchActivity(); }
  }, [open, isSessionVerified, fetchActivity]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const handleOpen = () => { setOpen((prev) => !prev); };

  const handleMarkSeen = () => {
    if (items && items.length > 0) {
      const newest = items.reduce((max, a) => new Date(a.occurredAt).getTime() > new Date(max).getTime() ? a.occurredAt : max, items[0].occurredAt);
      setLastSeenAt(newest);
      setUnreadCount(0);
    }
    setOpen(false);
  };

  if (!isSessionVerified) return null;

  const panelContent = (
    <>
      <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
        <h2 className="text-sm font-medium text-ballot-ink">Activity</h2>
        <div className="flex items-center gap-2">
          <Link href="/insights" onClick={() => setOpen(false)} className="text-micro text-nim-blue hover:text-signal-gold transition-colors">View all</Link>
          <Button type="button" variant="ghost" size="sm" onClick={fetchActivity} aria-label="Refresh activity">Refresh</Button>
        </div>
      </div>

      {loading && <p className="text-body text-quiet-ink text-center py-8">Loading activity…</p>}

      {error && !loading && (
        <div className="text-center py-8 px-4">
          <p className="text-body text-quiet-ink">{error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={fetchActivity} className="mt-3">Retry</Button>
        </div>
      )}

      {!loading && !error && items && items.length === 0 && (
        <div className="text-center py-8 px-4">
          <p className="text-body text-ballot-ink font-medium">No recent creator activity</p>
           <p className="text-micro text-quiet-ink mt-1">New votes and confirmed legacy NIM support will appear here.</p>
        </div>
      )}

      {!loading && !error && items && items.length > 0 && (
        <>
          {items.map((item) => {
            const tax = pollTaxonomy.get(item.pollId);
            return (
            <Link key={item.id} href={`/polls/${item.pollId}`} onClick={() => setOpen(false)}
              className="flex items-start gap-3 px-4 py-3 hover:bg-soft-fog transition-colors border-b border-divider last:border-b-0">
              <span className="flex-shrink-0 mt-0.5 text-quiet-ink">
                {item.type === "poll_published" && <PublishIcon />}
                {item.type === "vote_received" && <VoteIcon />}
                {item.type === "nim_support_confirmed" && <NimIcon />}
                {item.type === "poll_closed" && <ClosedIcon />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ballot-ink leading-snug">
                  {item.type === "poll_published" && `Published "${item.pollQuestion}"`}
                  {item.type === "vote_received" && `A vote was received for "${item.optionLabel}"`}
                  {item.type === "nim_support_confirmed" && `${formatLuna(item.amountLuna ?? "0")} support was confirmed for "${item.optionLabel}"`}
                  {item.type === "poll_closed" && `"${item.pollQuestion}" closed`}
                </p>
                {tax && (
                  <div className="mt-1">
                    <PollTaxonomyBadges category={tax.category} format={tax.format} size="sm" />
                  </div>
                )}
                <p className="text-micro text-quiet-ink mt-0.5">{formatTime(item.occurredAt)}</p>
              </div>
            </Link>
            );
          })}
          <div className="px-4 py-2 border-t border-divider text-center">
            <button type="button" onClick={handleMarkSeen} className="text-micro text-nim-blue hover:text-signal-gold transition-colors">Mark all as read</button>
          </div>
        </>
      )}
    </>
  );

  return (
    <div className="relative flex-shrink-0">
      <button ref={btnRef} type="button" onClick={handleOpen}
        className="relative min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-ballot-ink hover:bg-soft-fog transition-colors"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`} aria-expanded={open}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <path d="M7 15a2 2 0 004 0M4 7a5 5 0 0110 0v4l2 2H2l2-2V7z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-signal-gold text-[10px] font-medium text-ballot-ink leading-none px-1">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && mounted && (
        <>
          {createPortal(
            <div className="fixed inset-0 z-[9999] lg:hidden" onClick={handleOpen}>
              <div className="absolute inset-0 bg-ballot-ink/20 backdrop-blur-sm" aria-hidden="true" />
              <div ref={panelRef} className="absolute left-4 right-4 top-[72px] max-h-[calc(100dvh-88px)] overflow-y-auto overflow-x-hidden overscroll-contain bg-clear-ballot rounded-overlay border border-divider shadow-card"
                onClick={(e) => e.stopPropagation()}>
                {panelContent}
              </div>
            </div>,
            document.body,
          )}
          <div className="hidden lg:block">
            <div className="absolute right-0 top-full mt-2 w-[26rem] max-h-[400px] overflow-y-auto bg-clear-ballot rounded-overlay border border-divider shadow-card z-50">
              {panelContent}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PublishIcon() { return (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 2h7l4 4v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" /><path d="M10 2v4h4" stroke="currentColor" strokeWidth="1.2" /></svg>); }
function VoteIcon() { return (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 7.5L7.5 9.5L10.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" /></svg>); }
function NimIcon() { return (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="4" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M10 9h1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>); }
function ClosedIcon() { return (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" /><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>); }
