# AGENTS.md — Votum

## Stack
- Next.js 16.2.12 (App Router, `src/app/`)
- React 19.2.4
- Tailwind CSS v4 (config in `src/app/globals.css` via `@theme`, no `tailwind.config.js`)
- TypeScript 5, strict mode
- ESLint 9 (flat config: `eslint.config.mjs`)

## Commands
| Command | Runs |
|---------|------|
| `npm run dev` | Dev server at `localhost:3000` |
| `npm run build` | Production build (`next build`) |
| `npm run start` | Start production server |
| `npm run lint` | ESLint (whole project) |
| `npx tsc --noEmit` | TypeScript type check |

No test runner configured.

## Architecture

### Source of truth
- `DESIGN.md` — visual system, layout, typography, colours, components
- `docs/brand-messaging.md` — product language, terminology, tone
- `docs/votum-product-idea.md` — product behaviour, audience, boundaries

### Project structure
```
src/
  app/           — App Router pages (layout.tsx, page.tsx, globals.css)
  components/
    ui/          — Reusable primitives (Button, Card, Badge, Input, etc.)
    product/     — Product-level shells (PollCard, PollOption, VotumReceipt, etc.)
    state/       — Empty/Loading/Error/Unavailable/WalletRequired states
    layout/      — MarketingShell, ProductShell, MarketingNav, ProductNav
```

### Routes (prepared, not fully built)
- `/` — MarketingShell
- `/how-it-works` — MarketingShell
- `/explore` — ProductShell
- `/create` — ProductShell
- `/polls/[pollId]` — ProductShell (dynamic)
- `/polls/[pollId]/receipt/[receiptId]` — ProductShell (dynamic)
- `/my-polls` — ProductShell
- `/my-polls/[pollId]` — ProductShell (dynamic)

### Design tokens (Tailwind v4 `@theme`)
Colors: `soft-fog`, `clear-ballot`, `ballot-ink`, `quiet-ink`, `micro-grey`, `signal-gold`, `deep-gold`, `nim-blue`, `verified-green`, `fairness-amber`, `reject-red`, `border`, `divider`
Radius: `card` (24px), `overlay` (20px), `thumbnail` (16px), `full` (pill)
Shadow: `card` (0 4px 16px rgba(0,0,0,0.04))
Fonts: `font-display` (General Sans/Inter fallback), `font-body` (Inter), `font-proof` (IBM Plex Mono)

### Key rules
- Votum is NOT betting, prediction market, gambling, or winner-takes-pot
- Signal Gold = single CTA colour; NIM Blue = informational/proof; Green = verified only
- Never rely on colour alone — pair with text and icon
- No fake/mock data in the application
- WalletButton is UI-only placeholder; no wallet SDKs connected
- `@/*` maps to `./src/*`
