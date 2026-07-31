# Votum

The Proof Ballot — a Nimiq Pay Mini App for community decisions backed by NIM.

Votum helps communities make decisions with verified NIM-backed votes inside
Nimiq Pay. Put NIM behind your say.

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build

```bash
npm run build
npm run start
```

## Nimiq Pay Mini App Development

Votum is a Nimiq Pay Mini App. It initializes the Nimiq provider when opened
inside Nimiq Pay and requests wallet account access after a user action.

### Environment variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_APP_URL` | Public HTTPS URL of the *published* Mini App. Required to generate a shared `nimiqpay://` deeplink. Not needed for local network testing — enter the local URL directly in Nimiq Pay. |

### Local network testing

Connect your phone and development machine to the same Wi-Fi network.

Start the dev server with network access:

```bash
npm run dev -- --hostname 0.0.0.0
```

The `--` separates npm args from Next.js args. The server prints your
machine's local IP address. Open the Nimiq Pay Mini Apps testing interface
and enter the full URL directly:

```
http://192.168.1.42:3000
```

> Local network testing does **not** require `NEXT_PUBLIC_APP_URL`. The
> URL is entered directly — no `nimiqpay://` deeplink is used.

### Production deeplink (published sharing)

When Votum is deployed to a public HTTPS host, set `NEXT_PUBLIC_APP_URL`
to the deployment URL (e.g. `https://votum.example.com`).

The deeplink helper in `src/lib/nimiq/deeplink.ts` constructs:

```
nimiqpay://miniapp?url=votum.example.com
```

`getNimiqPayDeepLink()` returns `null` for:
- Unset `NEXT_PUBLIC_APP_URL`
- `localhost` and `127.0.0.1`
- Private IP ranges (`10.x.x.x`, `172.16–31.x.x`, `192.168.x.x`)
- Non-HTTPS public URLs
- Malformed URLs

Only a valid public HTTPS host produces a shareable deeplink.

### Testing inside Nimiq Pay

The SDK (`@nimiq/mini-app-sdk`) initializes automatically when the
`window.nimiq` provider is injected by Nimiq Pay. The `init()` call waits
up to 5 seconds for the provider before reporting the environment as
unavailable.

**On-device testing** (recommended):
1. Connect phone and machine to the same Wi-Fi
2. Run `npm run dev -- --hostname 0.0.0.0`
3. Open Nimiq Pay → Mini Apps → enter `http://<your-ip>:3000`
4. Verify the provider initializes (wallet button shows "Connect wallet")
5. Tap Connect wallet and approve the account access prompt
6. Confirm your Nimiq address appears

**Deployed testing**:
1. Deploy Votum to a public URL (Vercel, Netlify, etc.)
2. Set `NEXT_PUBLIC_APP_URL` to the deployment URL
3. Use the Nimiq Pay deeplink: `nimiqpay://miniapp?url=example.com`

### Sharing your Mini App

Once deployed, share using the official Nimiq Pay deeplink format:

```
nimiqpay://miniapp?url=votum.example.com
```

The deeplink helper in `src/lib/nimiq/deeplink.ts` constructs this
from `NEXT_PUBLIC_APP_URL`. It returns `null` for localhost URLs.

### Wallet connection flow

1. Tap **Connect wallet**
2. Nimiq Pay shows the account access prompt
3. Approve to return your Nimiq addresses
4. Votum stores addresses in memory (no persistence)
5. Tap **Disconnect from Votum** to clear the session

### Rejection handling

If you deny the account access prompt, Votum shows a permission-denied
state with the option to try again.

### Outside Nimiq Pay

When opened in a regular browser, Votum shows an `unavailable` runtime
state after the 5-second provider timeout. Marketing pages remain usable.
Product routes explain that wallet actions require Nimiq Pay. The app
does not crash.

## Supabase

Votum uses Supabase for public poll storage and retrieval.

### Environment

| Variable | Source |
|----------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase Dashboard → Settings → API → anon/public key |

No service-role or secret key is needed for public reads.

### Migration

```bash
# Link the project (requires Supabase CLI)
npx supabase link --project-ref <ref>

# Apply migrations
npx supabase db push

# Or run manually against your Supabase SQL editor
```

The migration file is at `supabase/migrations/0001_votum_poll_foundation.sql`.

### Security model

- **Public reads only**: `SELECT` on `polls` (live/closed, is_public=true)
  and `poll_options` (belonging to public polls only)
- **No public writes**: `INSERT`, `UPDATE`, and `DELETE` are revoked for
  `anon` and `authenticated` roles
- **Row Level Security** enforced on both tables
- No Supabase Auth used yet — all access is anonymous
- No wallet proof required for public poll reading

### Verify

```sql
-- Confirm anonymous writes are denied (should fail with permission error)
INSERT INTO public.polls (creator_wallet, question, mode, destination_wallet, destination_purpose, min_nim_luna, ends_at) VALUES ('NQ...', 'test', 'creator_support', 'NQ...', 'test', 100000, now() + interval '7 days');
-- Expected: ERROR: new row violates row-level security policy
```

### Database types

When the project is linked, generate types with:
```bash
npx supabase gen types typescript --linked > src/types/database.ts
```

A compatible schema definition is already at `src/types/database.ts`.

### Public read architecture

- `src/lib/supabase/config.ts` — validates env vars, creates client
- `src/lib/data/public-polls.ts` — `listPublicPolls()`, `getPublicPollById()`
- Queries use the publishable key only (no service role)
- Server-side only (never imported into client components)

## Wallet Ownership Verification

Votum proves wallet ownership through a cryptographic challenge-response
flow using the Nimiq Mini App `sign()` method.

### How it works

1. User taps **Verify wallet ownership**
2. Server generates a signed challenge message (5-minute expiry)
3. Nimiq Pay shows a signature confirmation dialog
4. User approves — signature and public key are sent to Votum
5. Server verifies: signature is valid, public key derives to the claimed address
6. HTTP-only session cookie is set (12-hour expiry)
7. Refresh preserves verified state
8. **End verified Votum session** clears the cookie

### Signing convention

The Mini App `sign(message)` signs the UTF-8 bytes of the message string.
Verification uses `@nimiq/core` `PublicKey.verify()` over the same bytes.
The public key's derived address must match the connected wallet address.

### Signature convention calibration

The exact bytes signed by the Mini App `sign(message)` API have not been
confirmed through device testing. Two candidate conventions are supported
for calibration:

1. **Raw UTF-8** — `sign(message)` signs the UTF-8 bytes of the string directly
2. **Nimiq prefixed message** — `\x16Nimiq Signed Message:\n` + length + message, SHA-256 hashed

To determine which convention Nimiq Pay uses:

1. Run `npm run dev -- --hostname 0.0.0.0`
2. Connect your phone to the same Wi-Fi
3. Open Nimiq Pay and enter `http://<your-ip>:3000`
4. Go to `/create`, complete enough of the form to reach Review
5. Tap **Test Nimiq Pay signature** under the calibration section
6. Approve the native signing confirmation
7. Record the three boolean results shown

**Device tested:** Not yet tested. Signature convention is DEVICE-UNVERIFIED.

**Test procedure prepared:** Calibration route at `/api/dev/wallet-proof/calibrate`
(development only). Diagnostic UI on `/create` Review step. The route is
blocked in production.

### Server architecture

- `src/lib/nimiq/server-crypto.ts` — address normalization, derivation, verification
- `src/lib/api/session.ts` — session token management (hashed, HTTP-only cookie)
- `src/lib/supabase/admin.ts` — server-only admin client (secret key)
- `POST /api/wallet-proof/challenge` — creates a one-time challenge
- `POST /api/wallet-proof/verify` — verifies signature, establishes session
- `GET /api/wallet-proof/session` — checks current session
- `POST /api/wallet-proof/logout` — revokes session

### Security

- Challenge cannot be reused (atomically consumed)
- Session token is SHA-256 hashed before storage
- Raw token never leaves the HTTP-only cookie
- `wallet_challenges` and `wallet_sessions` tables have no public access
- Secret key (`SUPABASE_SECRET_KEY`) is never exposed to client bundles
- Wallet connection is separate from verified session

### Dependencies

- `@nimiq/core` — server-side address/public-key/signature operations

## Project Structure

```
src/
  app/              — App Router pages
  components/
    ui/             — Reusable primitives
    product/        — Product-level components
    poll/           — Poll view components
    creator/        — Creator view components
    decision/       — Create-flow components
    state/          — Empty/Loading/Error/Unavailable states
    layout/         — MarketingShell, ProductShell, navigation
    marketing/      — Landing page components
  hooks/            — Shared React hooks
  lib/              — Utilities (format, Nimiq client, deeplink)
  providers/        — React context providers
  types/            — Shared TypeScript types
```

## Stack

- Next.js 16 (App Router)
- React 19
- Tailwind CSS v4
- TypeScript (strict)
- @nimiq/mini-app-sdk

## Commands

| Command | Runs |
|---------|------|
| `npm run dev` | Dev server |
| `npm run dev -- --hostname 0.0.0.0` | Dev server with network access |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | TypeScript type check |

## Current Status

Complete MVP with:

- Nimiq Pay Mini App wallet connection and ownership verification
- Poll creation, publishing, and atomic database insertion
- Explore (public) and My Polls (creator-owned) listings
- One wallet · one vote with real vote results
- Direct NIM support through Nimiq Pay (`sendBasicTransactionWithData`)
- Pending-to-confirmed transaction verification via Nimiq PoS RPC
- Separate vote and NIM support totals
- Confirmed contribution restoration after refresh
- Real mainnet NIM support successfully tested
- Nimiq network ID: 24 (mainnet)

## Deployment

### Prerequisites

- Node.js 18+
- Supabase project with migrations applied
- Nimiq Pay developer access for Mini App testing

### Environment variables

| Variable | Public | Required | Source |
|----------|--------|----------|--------|
| `NEXT_PUBLIC_APP_URL` | Yes | Production | Your deployed HTTPS URL (e.g. `https://votum.vercel.app`) |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Always | Supabase Dashboard → Settings → API |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes | Always | Supabase Dashboard → Settings → API → anon key |
| `SUPABASE_SECRET_KEY` | **No** | Always | Supabase Dashboard → Settings → API → service_role key |
| `NIMIQ_RPC_URL` | **No** | NIM support | Nimiq PoS JSON-RPC endpoint (HTTPS required) |
| `NIMIQ_NETWORK_ID` | **No** | NIM support | `24` for mainnet |

**Never prefix `SUPABASE_SECRET_KEY`, `NIMIQ_RPC_URL`, or `NIMIQ_NETWORK_ID` with `NEXT_PUBLIC_`.**

### Vercel deployment

1. Import the repository into Vercel
2. Set all environment variables in Vercel project settings
3. Apply Supabase migrations: `npx supabase db push` (requires linked project)
4. Deploy

Votum requires **Node.js runtime** (not Edge) for API routes using `@nimiq/core` WASM and `node:crypto`.

### Migration

All Supabase migrations are in `supabase/migrations/`. Apply with:

```bash
npx supabase db push
```

### Local production build

```bash
npm run build
npm run start -- --hostname 0.0.0.0
```

### Architecture

Votum never holds, escrows, or redistributes NIM. All support goes
**directly from supporter to the disclosed poll destination**. Voting
and NIM support are separate — NIM never increases vote weight.

## Design

See `DESIGN.md` for the visual system.
See `docs/brand-messaging.md` for product language and tone.
See `docs/votum-product-idea.md` for product scope and audience.
