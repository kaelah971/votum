# V2A.7 — Nimiq Pay Device QA

**Date:** 2026-08-05
**Tested commit:** `350c45a fix(v2a7f): correct cleanup method name from destroy to dispose`
**Device:** Physical phone running Nimiq Pay
**Method:** Local Wi-Fi LAN (`http://192.168.0.2:3000`)
**Toolkit:** Nimiq Pay Mini Apps WebView

---

## Checklist Results

| Check | Result |
|-------|--------|
| Nimiq Pay launch | PASS — landing page renders inside Mini App |
| Provider initialization | PASS — wallet connect flow works |
| Wallet authentication | PASS — signed-message auth completes |
| Default Explore | PASS — 2 Closing soon, 2 Live now, 2 Recently closed |
| Category filter | PASS — Sports/Entertainment/etc update results |
| Format filter | PASS — Prediction/Fan vote update results |
| Status filter | PASS — Live hides RC, Closed hides CS/LN |
| Sort (grouped/flat) | PASS — Grouped/Recent/Closing all work |
| Search/debounce | PASS — works in flat modes; minor delay in grouped |
| Clear filters | PASS — appears when active, resets to /explore |
| Flat Load more | N/A — only 6 QA fixtures (no second page) |
| Grouped Load more | N/A — same |
| Empty state | PASS — "No polls match your filters" + Create link |
| Core vote smoke test | PASS — vote cast, duplicate prevented |
| Duplicate-vote prevention | PASS — second vote blocked |
| Mobile keyboard | PASS — search field stays visible |
| Overflow/layout | PASS — no horizontal overflow, rails scrollable |
| Console errors | Minor — grouped search refresh timing |
| Device back-navigation | PASS — stays inside Mini App |

---

## Issues Found

| Severity | Description | Status |
|----------|-------------|--------|
| Important | `coordinator.destroy` undefined crash | FIXED — renamed to `dispose()` |
| Minor | Search in grouped mode doesn't always refresh results immediately | Documented |

---

## Automated Gate

- V2A.7C: 58/58
- V2A.7D: 71/71
- V2A.7E: 52/52
- TypeScript: 0 errors
- ESLint: 0 errors, 0 warnings
- Build: PASS

---

## Remaining Limitations

1. Shared AbortController prevents parallel grouped Load more (V2A.8)
2. Fresh request time per grouped continuation (bounded, safe)
3. Search in grouped mode refresh timing (Minor)

---

## Final Result

**PASS WITH MINOR LIMITATIONS**

V2A.7 Explore is ready for production consideration. All core features work on a physical Nimiq Pay device. One Important crash was found and fixed (coordinator dispose). Device QA passed: authentication, explore, filtering, sorting, search, clear filters, voting, layout.
