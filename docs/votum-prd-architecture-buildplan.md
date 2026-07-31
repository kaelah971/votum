# Votum — PRD, Architecture, and Build Plan

**Product:** Votum  
**Platform:** Nimiq Pay Mini Apps Framework  
**Core action:** A verified NIM contribution records a community vote  
**MVP mode:** Creator Support Poll and Community Support Poll  
**Product rule:** Signal before spectacle.

## 1. Product goal

Build a polished, mobile-first Nimiq Pay Mini App where users can create a public Votum poll, share it, collect NIM-backed votes, and view live/final results with transparent contribution destination and transaction-backed proof.

A user should create a poll in under 60 seconds. A voter should understand what their NIM supports before confirming payment.

## 2. User stories

| ID | Story | Priority |
|---|---|---|
| US-01 | As a creator, I can create a poll with question, 2–6 options, duration, NIM minimum, and contribution destination. | Must |
| US-02 | As a voter, I can see where my NIM goes before I pay. | Must |
| US-03 | As a voter, I can choose one option and pay NIM inside Nimiq Pay. | Must |
| US-04 | As the app, I record a vote only after valid transaction confirmation. | Must |
| US-05 | As a voter, I can see wallet count and NIM signal separately. | Must |
| US-06 | As a creator, I can share a public poll URL or QR code. | Must |
| US-07 | As anyone, I can see final results after closing. | Must |
| US-08 | As a voter, I cannot vote twice in one-wallet-one-vote mode. | Must |
| US-09 | As a user, I can recover clearly from failed or cancelled payment. | Must |
| US-10 | As a creator, I can view created polls. | Should |
| US-11 | As a user, I can view featured public polls. | Should |
| US-12 | As a user, I can share a data-minimised Votum Receipt. | Should |
| US-13 | As a creator, I can use capped or quadratic weighting. | Defer |

## 3. MVP scope

### Build now

- create Votum poll;
- public poll detail page;
- NIM payment request through Nimiq Pay;
- server-side/client-verifiable transaction validation appropriate to framework capabilities;
- verified-vote persistence;
- one-wallet-one-vote default;
- live results;
- automatic closed-state behaviour;
- Creator Support and Community Support contribution destinations;
- share link and simple QR code;
- creator poll list;
- mobile-first error, loading, empty, payment-cancelled and closed-poll states;
- public transaction-proof reference;
- clear non-gambling contribution language.

### Defer

- escrow/custody;
- refund mechanics;
- winner-payout or pot splitting;
- anonymous voting;
- private polls;
- full governance/DAO tooling;
- multi-token payments;
- advanced reputation/badges;
- complex quadratic weighting;
- any claim that direct creator-wallet payment automatically funds a specific winning option.

## 4. Contribution modes

| Mode | What happens | MVP status |
|---|---|---|
| Creator Support | NIM goes directly to disclosed creator/project wallet | Build |
| Community Support | NIM goes directly to disclosed community/project wallet | Build |
| Fund the Winner | Creator commits to use support toward selected direction; no escrow guarantee | Copy only / transparent future extension |
| Refundable Signal | Requires a reliable outbound refund system | Defer |
| Winner Reward | Can look like gambling or prize-pool distribution | Reject for contest MVP |

## 5. Core flow

### Create

1. Creator opens Votum in Nimiq Pay.
2. Wallet identity is read through framework connection.
3. Creator selects template or starts blank.
4. Creator enters question, options, duration, minimum NIM, and destination wallet/purpose.
5. Creator sees a review screen.
6. Creator publishes a public poll.
7. Creator shares URL/QR.

### Vote

1. Voter opens poll inside Nimiq Pay.
2. App shows question, selected support mode, destination wallet, minimum NIM and fairness rule.
3. Voter selects an option.
4. App creates a pending vote intent.
5. Nimiq Pay opens payment confirmation.
6. Payment is confirmed and validated.
7. Vote is stored.
8. Live result updates.
9. Voter receives Votum Receipt.

### Close

1. Poll becomes closed when deadline passes.
2. New vote intents are rejected.
3. Final Result shows leading option, wallet count, NIM signal, total contributions and public proof references.

## 6. Information hierarchy

On every poll, show in this order:

1. Poll question.
2. What the NIM supports.
3. Where NIM goes.
4. Minimum contribution.
5. Options.
6. Fairness rule.
7. Time remaining.
8. Vote action.
9. Live results after verified payment.

Do not place total NIM above the question or creator purpose. The product is a decision tool, not a speculative money screen.

## 7. Architecture

### Stack

| Layer | Choice |
|---|---|
| Mini App / frontend | SvelteKit + TypeScript strict mode |
| Styling | Tailwind CSS with mobile-first tokens |
| Wallet/payment | Nimiq Pay Mini Apps Framework provider/API |
| Database | Supabase Postgres |
| Live updates | Supabase Realtime |
| Identity | Wallet address; no email auth in MVP |
| Hosting | Vercel or compatible deployment |
| Share cards | Server route or static HTML/OG-image generator |
| Analytics | Lightweight event table or privacy-conscious analytics |

### Data flow

```text
Nimiq Pay Mini App
  → SvelteKit client
  → create poll / pending vote intent
  → Nimiq Pay payment confirmation
  → transaction verification
  → Supabase vote persistence
  → Supabase Realtime result update
```

### Custody rule

Votum does not hold funds. The NIM payment goes directly to the disclosed destination wallet. Votum verifies the payment and records the vote. This reduces security, legal and implementation risk.

## 8. Data model

### users

| Field | Type | Notes |
|---|---|---|
| id | uuid | Primary key |
| wallet_address | text unique | Wallet identity |
| display_name | text nullable | Optional profile label |
| created_at | timestamptz | Timestamp |

### polls

| Field | Type | Notes |
|---|---|---|
| id | uuid | Primary key |
| creator_wallet | text | Creator identity |
| question | text | Main poll question |
| description | text nullable | Context / support purpose |
| mode | enum | creator_support, community_support |
| destination_wallet | text | Visible before payment |
| destination_purpose | text | Plain-language use of contribution |
| min_nim_amount | numeric | Minimum NIM contribution |
| weighting_mode | enum | default one_wallet_one_vote |
| status | enum | draft, live, closed, cancelled |
| starts_at | timestamptz | Start time |
| ends_at | timestamptz | End time |
| is_public | boolean | Public page control |

### poll_options

| Field | Type |
|---|---|
| id | uuid |
| poll_id | uuid |
| label | text |
| description | text nullable |
| sort_order | integer |

### votes

| Field | Type | Notes |
|---|---|---|
| id | uuid | Primary key |
| poll_id | uuid | Poll reference |
| option_id | uuid | Chosen option |
| voter_wallet | text | Duplicate guard |
| nim_amount | numeric | Visible signal amount |
| vote_weight | numeric | `1` in default fairness mode |
| transaction_hash | text unique | Payment proof |
| status | enum | pending, verified, failed, cancelled |
| created_at | timestamptz | Timestamp |

## 9. API routes

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/polls` | Validate and create a poll |
| GET | `/api/polls/:id` | Fetch public poll data |
| POST | `/api/polls/:id/vote-intent` | Validate eligibility and create pending vote intent |
| POST | `/api/polls/:id/confirm-vote` | Validate transaction and persist verified vote |
| GET | `/api/polls/:id/results` | Fetch live/final result data |
| GET | `/api/me/polls` | Creator dashboard |
| POST | `/api/polls/:id/close` | Close expired poll if scheduled job is unavailable |

## 10. Security and fairness

- validate question length, option count, duration and minimum NIM;
- validate destination wallet format;
- validate transaction recipient equals poll destination wallet;
- validate transaction amount meets the minimum NIM amount;
- validate a transaction hash is not reused;
- reject duplicate wallet votes in default mode;
- reject votes after close time;
- store a vote only after transaction verification;
- use Supabase RLS for private creator actions;
- never store private keys;
- never custody user NIM;
- display destination and purpose before payment;
- use “support,” “contribution” and “signal,” never betting language.

## 11. Four-week build plan

### Week 1 — Foundation

- Install Nimiq Mini Apps framework/skill and test local Mini App in Nimiq Pay.
- Set up SvelteKit, Tailwind, Supabase and schema.
- Build mobile app shell and wallet identity state.
- Implement Create Poll and public detail page.
- Seed two Nimiq-community demo polls.

**Deliverable:** creator can publish a public Votum poll.

### Week 2 — NIM voting

- Implement pending vote intent.
- Integrate Nimiq Pay NIM payment request.
- Verify confirmed transaction and persist votes.
- Add duplicate-vote and closed-poll controls.
- Implement live results and Votum Receipt.

**Deliverable:** verified NIM vote updates a public poll result.

### Week 3 — Community testing

- Add creator list, share links and QR code.
- Add final result state and transaction-proof links.
- Run real polls with Nimiq builders and collect feedback.
- Improve wording around contribution destination and fairness.
- Add Featured Polls only if core flow is stable.

**Deliverable:** real users can create, share and vote in public Votum polls.

### Week 4 — Polish and submission

- Finish mobile UX, loading/error/empty states and localisation where feasible.
- Produce README, screenshots, demo video and public build thread.
- Confirm framework functionality and submit PR to official competition repository.
- Publish clear NIM usage and community-testing metrics.

**Deliverable:** live, useful, documented Mini App with real NIM-backed votes.

## 12. Demo script

1. Open Votum in Nimiq Pay.
2. Create a poll: “Which community resource should we build next?”
3. Set 1 NIM minimum and show the community wallet destination.
4. Publish and open via QR code.
5. Choose an option and confirm NIM payment.
6. Show transaction verification.
7. Show immediate result update: wallet count and NIM signal.
8. Open the Votum Receipt and final-result state.

### Demo line

> **This is not a free poll. Every vote carries a transparent NIM-backed signal.**

## 13. Success metrics

| Metric | Cycle target |
|---|---:|
| Unique wallets casting verified NIM-backed votes | 50–150+ |
| Successful vote transactions | 100+ |
| Public polls created | 20+ |
| Community demo polls | 5+ |
| Create-to-share time | Under 60 seconds |
| Payment-cancelled flow clarity | No stranded pending votes |
| Public build/community updates | 10+ |

## 14. Definition of done

The Cycle 1 MVP is complete only when a real user can create a public Votum poll, clearly understand what the NIM supports, cast a NIM-backed vote in Nimiq Pay, see verified live/final results, and inspect transaction-backed proof—without the product looking or behaving like gambling.
