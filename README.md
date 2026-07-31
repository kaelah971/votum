# Votum

**Put NIM behind your say.**

Votum is a Nimiq Pay Mini App for community decisions backed by NIM.
Create a poll, collect verified one-wallet-one-vote results, and let your
community put real NIM support behind what they care about.

## The problem

Free online polls are easy to click, ignore, spam, or brigade. A click
does not show whether someone will support the resulting decision. Votum
adds a lightweight, visible contribution behind participation — not as
betting, but as accountable community signal.

## How it works

1. **Create** a Votum Poll with a clear question, options, a disclosed
   NIM destination, and a minimum contribution.
2. **Share** the poll link.
3. **Voters** verify their Nimiq wallet, cast one vote, and optionally
   send NIM support directly to the disclosed destination.
4. **Results** show wallet participation and NIM support separately.

## Features

- **One wallet · one vote** — every verified Nimiq wallet gets exactly
  one vote per poll. NIM amount never increases vote weight.
- **Direct NIM support** — supporters send NIM directly to the poll's
  disclosed recipient. Votum never holds, escrows, or redistributes funds.
- **On-chain verification** — NIM contributions are verified against the
  Nimiq blockchain before being counted in public totals.
- **Separate totals** — votes and NIM support are displayed independently.
- **Pending-to-confirmed** — transactions are tracked through Nimiq
  network inclusion with automatic polling and refresh-safe restoration.
- **Initiator vs payer** — the Votum session wallet initiates support,
  but Nimiq Pay may fund it from another approved account. Both are valid.
- **Local drafts** — unfinished polls auto-save and survive refresh.
- **Public and creator views** — Explore lists all public polls. My Polls
  shows only polls created by your verified wallet.
- **Session-aware reconnect** — reconnecting the matching wallet restores
  your verified session without another signature.

## Technology

- Next.js 16 (App Router)
- React 19
- Tailwind CSS v4
- TypeScript (strict)
- Supabase (PostgreSQL, RLS, migrations)
- @nimiq/mini-app-sdk
- @nimiq/core (server-side crypto)
- Nimiq PoS JSON-RPC (transaction verification)

## Getting Started

### Prerequisites

- Node.js 18+
- npm
- Supabase project
- Nimiq Pay (for Mini App testing)

### Install

```bash
npm install
```

### Development

```bash
npm run dev
npm run dev -- --hostname 0.0.0.0  # for Nimiq Pay local-network testing
```

### Build

```bash
npm run build
npm run start
npm run start -- --hostname 0.0.0.0  # for local-network production testing
```

### Tests

```bash
npm run lint
npx tsc --noEmit
npx tsx src/lib/nimiq/crypto-consistency.ts
node --env-file=.env.local --import tsx src/lib/api/publish-test.ts
node --env-file=.env.local --import tsx src/lib/api/vote-test.ts
node --env-file=.env.local --import tsx src/lib/support/support-regression-test.ts
```

## Environment variables

| Variable | Public | Required | Source |
|----------|--------|----------|--------|
| `NEXT_PUBLIC_APP_URL` | Yes | Production | Deployed HTTPS URL |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Always | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes | Always | Supabase → API → anon key |
| `SUPABASE_SECRET_KEY` | No | Always | Supabase → API → service_role key |
| `NIMIQ_RPC_URL` | No | NIM support | Nimiq PoS RPC endpoint |
| `NIMIQ_NETWORK_ID` | No | NIM support | `24` for mainnet |

Copy `.env.example` to `.env.local`. Never commit `.env.local`.

## Supabase migrations

```bash
npx supabase db push
```

All migrations are in `supabase/migrations/`. The database uses Row Level
Security — public roles have SELECT-only access to published polls.
Private tables (votes, contributions, sessions, challenges) are accessible
only via the service_role key.

## Nimiq Pay Mini App

Votum runs inside Nimiq Pay as a Mini App. It initializes the Nimiq
provider via `@nimiq/mini-app-sdk` and requests wallet access only after
explicit user action. Wallet ownership is proven through a cryptographic
challenge-response flow using the Nimiq `sign()` method.

Outside Nimiq Pay, the app renders normally — wallet features show
appropriate guidance without crashing.

## Production

Deployed at: **https://votum-five.vercel.app**

Nimiq network: **mainnet (ID 24)**

For deep links: `nimiqpay://miniapp?url=votum-five.vercel.app`

## Security

- Wallet sessions use HttpOnly cookies and server-side SHA-256 hashed tokens.
- Creator identity is derived exclusively from the verified server session.
- All NIM support goes directly from supporter to disclosed destination.
- Votum never holds, escrows, or redistributes NIM.
- Vote and NIM support totals are always separate.
- One wallet gets exactly one vote per poll — enforced at database level.

## Known limitations

- No poll editing or deletion after publishing.
- Votes are immutable — no vote changing.
- NIM support receipts are inline only (no dedicated receipt page).
- Drafts are browser-local (not synced across devices).
- No creator analytics dashboard.
- No multi-language support.

## Design

See `DESIGN.md` for the visual system.
See `docs/brand-messaging.md` for product language and tone.
See `docs/votum-product-idea.md` for product scope and audience.
