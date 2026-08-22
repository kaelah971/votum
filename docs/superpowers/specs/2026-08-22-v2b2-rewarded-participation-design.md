# V2B.2 — Creator-Funded Rewarded Participation (Design Spec)

**Status:** Design approved — **product decisions D1–D10 locked**. No
implementation, no migration, no deployment.
**Date:** 2026-08-22
**Branch:** `feat/v2-participation-record`
**Starting HEAD:** `dc306cd0503848ce58ea1389e781c63e02e2b491` (V2B.1 complete, pushed)
**Depends on:** V2A (Explore, publish, vote, support), V2B.1 (verified identities, profiles, sessions)
**Scope:** Design specification + locked decisions. An implementation plan is a
separate companion document (`docs/superpowers/plans/2026-08-22-v2b2-rewarded-participation-implementation.md`).

---

## 0.1 Locked Product Decisions (D1–D10)

| # | Decision | Locked |
|---|----------|--------|
| D1 | **Creator self-participation:** creator may participate/vote in their own poll; is **NOT** reward-eligible for their own campaign; voting power unchanged (one-wallet-one-vote intact) | ✅ |
| D2 | **Private polls:** V2B.2 reward campaigns are **public polls only**; private rewards deferred; private polls remain normal free polls | ✅ |
| D3 | **Reward delivery:** **AUTOMATIC payout** — verified participation → atomic reservation → automatic payout attempt → paid/retryable. **No participant Claim button.** Reward never depends on selected option | ✅ |
| D4 | **Refund timing:** **explicit creator-initiated** refund; allowed only when campaign closed/cancelled per policy AND no unresolved reserved/payout_pending rewards remain. No automatic timed refunds | ✅ |
| D5 | **Overpayment:** confirmed funding above required amount **must NOT** raise max participants, reward per participant, or any term; confirmed excess is **creator-owned refundable excess**; terms immutable | ✅ |
| D6 | **Minimum reward:** MVP minimum **0.01 NIM = 1,000 Luna**, expressed as ONE centralized product/domain constant (no scattered numeric literals); all money integer Luna | ✅ |
| D7 | **Public transparency:** public rewarded-poll UX shows reward per participant, Funded/availability state, max participants, rewards remaining, total participant reward budget. Creator management additionally shows paid amount, pending amount, refundable amount, funding tx state, payout failures, refund state. **Never expose** vault key material, encrypted ciphertext, internal auth/session data, chosen vote options | ✅ |
| D8 | **Explore MVP:** additive only — Rewarded filter + reward badge/amount on rewarded cards + compact "Earn NIM" discovery section. **No** reward sorting, reward leaderboard, or Explore redesign. V2A filter/pagination/search semantics intact | ✅ |
| D9 | **Network fee policy:** **creator bears payout/refund network fees**; participant receives the **exact advertised reward**. Accounting distinguishes (A) participant reward principal from (B) operational/network fee reserve — even though both fund the same isolated campaign address. Fee reserve never counts as reward budget, capacity, rewardsRemaining, or participant NIM earned | ✅ |
| D10 | **Cancel after funding:** before the **first reward reservation**, creator may cancel a funded campaign and recover eligible unused funds. Once the **first reward reservation exists**, terms become immutable — no cancel that invalidates advertised participant terms; creator may close → reconcile outstanding payouts → refund unused remainder | ✅ |

**Core product promise (preserved invariant):**

> Once rewarded participation begins, the creator **cannot** change reward per
> participant, maximum rewarded participants, participant reward principal,
> the poll associated with the campaign, or the creator refund destination.
> No rugging reward terms underneath participants.

The decision details are integrated into each relevant section below.

---

## 0. Product Thesis

Votum is a verified participation network where communities, creators, brands,
organizations and fanbases make stronger decisions — and optionally reward
people who participate with NIM.

**V2B.2 core rule — rewards are for participation, not outcomes:**

> A participant earns for verified participation. They **never** earn more for
> choosing the winning option, choosing the majority option, predicting
> correctly, or influencing an outcome.

Every eligible participant in a reward campaign receives the **same predefined
reward**, regardless of which option they selected.

This must **not** become a prediction market, betting, staking on outcomes,
pooled winner payouts, or outcome-linked rewards. The core voting rule
`ONE VERIFIED WALLET = ONE PARTICIPATION / ONE VOTE` is unchanged.

**Campaign shape (example):**

```
rewardPerParticipant = 0.5 NIM
maxRewardedParticipants = 200
requiredCampaignBudget = 100 NIM   (= 0.5 × 200)
```

The creator pre-funds the budget **before** Votum advertises the poll as
rewarded. Funding flows through Nimiq Pay / NIM.

**Votum must truthfully distinguish, at all times:**

```
configured → funding pending → funded → rewards available → reward exhausted
         → campaign closed → refundable remainder → refunded
```

**No fake reward balances.** Every displayed reward figure is derived from
authoritative records at read time; the profile's `nimEarnedLuna` placeholder
(`0`) is replaced only by confirmed settlement ledger truth (see §12).

---

## 1. Non-Negotiable Safety Rules

1. **Integer-only accounting.** Every stored/accounted money value is integer
   Luna (1 NIM = 100,000 Luna, repo constant `LUNA_PER_NIM`). No float in DB,
   API, or RPC. Decimal NIM exists only at the UI boundary via
   `nimDecimalToLuna` / `lunaToNim` / `formatNimAmount` (`src/lib/nimiq/units.ts`).
2. **Reward is outcome-independent.** Reward amount is fixed per campaign and
   identical for every eligible participant. No option, majority, winner, or
   prediction linkage — anywhere.
3. **No reward CTA on an unfunded campaign.** A poll is advertised as rewarded
   only when its campaign is `funded` and has remaining capacity.
4. **Wallet identity is immutable.** Reward identity = canonical-hex wallet
   (the same anchor as votes/support/profiles). Handles, display names, and
   sessions never change reward identity.
5. **One reward maximum per wallet per campaign.** Enforced by DB uniqueness,
   never by UI counters.
6. **Chain truth over client truth.** Funding, payout, and refund state is
   established by observing confirmed Nimiq transactions (RPC), never by a
   client callback or a broadcast hash alone.
7. **Money transitions are atomic DB operations.** Every balance/receipt
   transition is a single security-definer function body (or guarded by an
   advisory lock + unique constraint) so two users can never take the same
   final reward slot or double-pay.
8. **Never reveal the selected option.** Reward receipts, payout memos, profile
   stats, and activity expose participation and reward amount only — never
   `option_id`/choice.
9. **No fake/mock data.** Reward balances are derived; zero is truthful zero.
10. **Additive only.** Existing V1/V2 polls with no reward campaign behave
    exactly as today.
11. **Minimum reward floor.** Reward-per-participant is at least
    `MIN_REWARD_PER_PARTICIPANT_LUNA = 1000` (0.01 NIM) — one centralized
    domain constant (D6).
12. **Fee reserve is not reward money.** Network fees are creator-borne (D9);
    the fee reserve never counts toward reward budget, capacity,
    rewardsRemaining, or participant NIM earned.
13. **Terms immutability.** Once the first reward reservation exists, campaign
    terms (per-participant amount, max participants, principal, poll, refund
    destination) are immutable (D10 + core promise).
14. **Creator is not reward-eligible** for their own campaign, but may
    participate with full voting power (D1).

---

## 2. User Stories

- **Creator:** "I want to pay people to join my decision. I set 0.5 NIM per
  participant for up to 200 people, fund the principal plus a fee reserve, and
  Votum pays each participant the full 0.5 NIM automatically and truthfully."
- **Participant:** "I see a poll that honestly says 'Earn 0.5 NIM for
  participating'. I verify my wallet, vote once, and receive the full 0.5 NIM —
  no matter which option I chose, and no fees deducted."
- **Participant (late):** "If the reward cap was already filled, Votum tells
  me 'rewards exhausted' before I vote, and I can still participate for free."
- **Creator (close):** "After the poll closes and payouts reconcile, I
  explicitly request my unused reward principal and fee reserve back, with a
  transaction proof."
- **Creator (participant):** "I can vote in my own poll, but I am not eligible
  for my own reward."
- **Public:** "I can see on a profile that a wallet earned NIM for
  participating — but never which option they chose."

---

## 3. Creator Flow

```
1. Create poll (existing flow) + configure reward:
     rewardPerParticipant (NIM, ≥ MIN_REWARD_PER_PARTICIPANT_LUNA)
     maxRewardedParticipants (int ≥ 1)        → validated server-side
     rewardPrincipalLuna = perParticipantLuna × max   (exact bigint product)
     feeReserveLuna      = estimated payout/refund fees (fixed policy, D9)
     requiredFundingLuna = rewardPrincipalLuna + feeReserveLuna
2. reward_campaign created in state `configured` (0..1 per poll; poll_id UNIQUE).
3. Publish attempt for a rewarded poll returns reward_funding_required
   (campaign state, vault address, requiredFundingLuna) until campaign is funded.
4. Creator funds via Nimiq Pay:
     provider.sendBasicTransactionWithData({ recipient: vaultAddress,
        value: requiredFundingLuna (as Number, ≤ MAX_SAFE_INTEGER), data: funding memo })
5. Votum observes the funding tx by hash (RPC), verifies recipient = vault,
   amount ≥ requiredFundingLuna, memo matches, networkId matches, execution
   result true → campaign becomes `funded`.
   - amount exactly == requiredFundingLuna → principal + fee reserve allocated.
   - amount > requiredFundingLuna → excess recorded as creator-owned
     refundable excess (D5); terms unchanged.
6. Only then can the poll be published and advertised as rewarded.
7. Creator manages the campaign from /my-polls/[pollId] (see §11).
8. Creator may participate/vote in their own poll (D1) but is excluded from
   reward eligibility.
9. After the poll closes and payouts reconcile, creator explicitly requests a
   refund of unused principal + fee reserve (§7, D4). No automatic refund.
```

Decisions resolved in §4.

---

## 4. Reward Campaign Model (Design Question 1)

**Decision: one poll has zero or one reward campaign.** `reward_campaigns.poll_id`
is `UNIQUE`. MVP strongly prefers the simplest safe model; multiple campaigns
per poll add nothing but split-capacity and refund complexity, and would
confuse participants. If multiple reward tiers are ever needed, that is a
later model (e.g., a campaign referencing a poll plus a label), not pre-built.

**Entity fields (see §11 for full schema):**

```
id                        uuid PK
poll_id                   uuid UNIQUE REFERENCES polls(id)
creator_wallet            text NOT NULL        -- canonical hex; immutable owner + refund destination
reward_per_participant_luna bigint NOT NULL    -- same for every participant; ≥ MIN_REWARD (D6)
max_rewarded_participants int NOT NULL
reward_principal_luna     bigint NOT NULL      -- per × max; the participant budget (D9-A)
fee_reserve_luna          bigint NOT NULL      -- operational/network fee reserve (D9-B)
total_budget_luna         bigint NOT NULL      -- reward_principal_luna + fee_reserve_luna
asset/currency            text NOT NULL CHECK (= 'NIM')  -- NIM only for MVP
status                    text NOT NULL        -- lifecycle state (below)
funded_amount_luna        bigint NOT NULL DEFAULT 0      -- confirmed funding observed (chain truth)
refundable_excess_luna    bigint NOT NULL DEFAULT 0      -- confirmed over-funding, creator-owned (D5)
rewarded_participant_count int NOT NULL DEFAULT 0       -- receipts reserved/paid
paid_amount_luna          bigint NOT NULL DEFAULT 0      -- sum of confirmed participant payouts (principal only)
fee_spent_luna            bigint NOT NULL DEFAULT 0      -- confirmed network fees paid (D9-B)
refundable_amount_luna    bigint NOT NULL DEFAULT 0      -- confirmed remainder owed to creator (principal + fee + excess)
first_reservation_at      timestamptz NULL      -- D10 boundary: first reward reservation timestamp
vault_wallet              text NOT NULL        -- per-campaign vault address (§6)
vault_key_ref             text                 -- encrypted server-side vault key reference (§6)
created_at / funded_at / closed_at / refunded_at timestamptz NULL
updated_at                timestamptz NOT NULL
```

**Campaign lifecycle state machine:**

```
 configured ──(funding confirmed)──► funded ──► rewarding ──► exhausted
      │                                │            │           │
      │                                │            └──► closed ──► refunding ──► refunded
      │                                └───────────────► closed ────┘
      └──► cancelled (before funding; no funds at stake)
```

| From | Event | To | Guard |
|------|-------|----|-------|
| `configured` | funding transaction confirmed (recipient=vault, amount ≥ total, memo ok) | `funded` | atomic RPC; funding ledger row `confirmed` |
| `configured` | creator cancels | `cancelled` | creator session, no confirmed funding |
| `configured` | creator cancels a **funded** campaign with no reservation yet (D10) | `cancelled` → refund | creator session; `rewarded_participant_count = 0`; eligible unused funds refunded |
| `funded` | first reward receipt reserved/paid | `rewarding` | atomic claim; sets `first_reservation_at` (D10 immutability boundary) |
| `rewarding` | `rewarded_participant_count = max` | `exhausted` | atomic |
| `rewarding` / `exhausted` | poll status = closed | `closed` | poll close |
| `funded` | poll status = closed (no payouts yet) | `closed` | poll close |
| `closed` | all eligible receipts settled AND remainder > 0 | `refunding` | reconciliation + **explicit creator request** (D4) |
| `closed` | all eligible receipts settled AND remainder = 0 | `refunded` | reconciliation (nothing to refund) |
| `refunding` | refund tx confirmed | `refunded` | atomic; unique refund hash |

Notes:
- D10: cancel-after-funding is allowed **only** before the first reward
  reservation (`first_reservation_at IS NULL`). After that, campaign terms are
  immutable; the creator cannot cancel in a way that invalidates advertised
  participant terms — they close → reconcile → refund remainder.
- Refund state `refunding` is reached **only on explicit creator action** (D4);
  there is no automatic timed refund.
- State `configured`/`funding_pending` is **never** advertised as rewarded. The
  poll can exist as a draft, but publish for a rewarded poll is blocked until
  `funded` (§5).

---

## 5. Prepaid Funding (Design Question 2)

**Timing — funding happens before publish, and publishing a rewarded poll is
blocked until funding is confirmed.**

- Reward configuration is captured during create and stored on a `configured`
  campaign attached to the (draft) poll.
- An **unfunded rewarded draft can exist** (draft poll + `configured` campaign),
  but it is never advertised as rewarded and cannot be published as rewarded.
- `POST /api/polls/publish` for a poll with a campaign that is not `funded`
  returns `reward_funding_required` with the funding payload — the client then
  drives the Nimiq Pay funding, and the user retries publish.
- Rationale: the thesis states "fund the budget BEFORE Votum advertises the
  poll as rewarded". Blocking publish keeps the reward advertisement truthful
  by construction and keeps MVP logic simple (no "partially funded live poll").

**Funding transaction lifecycle (mirrors the proven NIM-support
`intent → bind → observe → confirm` pattern):**

```
POST /api/polls/[pollId]/reward/funding/intents     (creator session)
  → funding_tx row `submitted` with unique reference, amount=requiredFundingLuna,
    memo="votum-reward:<campaignId>", confirmation_deadline
  → return { vaultAddress, fundingLuna, principalLuna, feeReserveLuna, reference }
client sends tx in Nimiq Pay → hash → 
POST /api/polls/[pollId]/reward/funding/confirm { reference, txHash }
  → bind hash (partial-unique), observe getTransactionByHash,
    verify recipient=vault, amount ≥ requiredFundingLuna, memo, networkId, executionResult=true
  → confirm_reward_funding_atomic → campaign `funded`
```

- **Failed/underfunded:** an observed tx that does not match recipient/amount/
  memo is rejected (`funding_mismatch`); the funding row is `rejected`, the
  campaign stays `configured`/`funding_pending`, nothing is credited. No fake
  balance.
- **Minimum valid funding:** `amount ≥ total_budget_luna` (principal + fee
  reserve). Under-funding is rejected — a campaign cannot be `funded` with less
  than the required amount.
- **Duplicate funding attempts:** the funding `reference` is unique; the bound
  `transaction_hash` is partial-unique (one hash reserved by at most one
  funding row). Replays return `replay`/`bound_replay`; a second distinct
  confirmed hash is treated as over-funding (D5) — it is never used to raise
  capacity or per-participant reward.
- **Overpayment (D5):** if a confirmed funding amount exceeds
  `total_budget_luna`, the excess is recorded in `refundable_excess_luna`
  (creator-owned refundable excess). It **never** increases
  `max_rewarded_participants`, `reward_per_participant_luna`, or any term.
  Excess is refundable with the final creator refund.
- **Transaction hashes recorded** in the funding ledger row (bound hash,
  confirmed hash, block number, tx timestamp), like
  `nim_contributions.transaction_hash`.
- **Confirmation verified** via RPC `getTransactionByHash` with the exact
  field checks from `src/lib/nimiq/rpc.ts` (hash/from/to present, value ≥ 0,
  `executionResult === true`, `networkId` match, memo decode). Sender is
  **not** matched (consistent with support: Nimiq Pay may fund from any
  account); `initiator_wallet` (session) is recorded separately.
- **Fee reserve funding (D9):** the funding amount includes the fee reserve
  (`total_budget_luna = reward_principal_luna + fee_reserve_luna`). The fee
  reserve is **not** participant reward budget and does not affect capacity or
  rewardsRemaining (see §6 accounting).

---

## 6. Fund Custody / Settlement Architecture (Design Question 3)

### Evaluation

| Criterion | A. Isolated vault | B. Creator signs every payout | C. Shared treasury | D. Nimiq multisig | E. Cashlinks |
|-----------|-------------------|-------------------------------|--------------------|-------------------|--------------|
| Custody | Votum holds a per-campaign key (disclosed) | Creator holds all keys (zero Votum custody) | Votum holds one key for all campaigns | Distributed (not built in SDK) | Creator/vault signs once; anyone redeems |
| Operational risk | Key storage must be encrypted; single-campaign blast radius | Creator must be online/sign each payout (200 txs!) | Single key = single point of failure for ALL funds | High setup complexity | Link expiry/redeem races |
| Payout automation | High — server signs + broadcasts | Low — needs creator per payout | High | Low | Medium |
| Auditability | Per-campaign ledger + chain | Chain + local records | Internal ledger must reconcile | Chain | Chain + link state |
| Blast radius | **One campaign per key** | Creator's own risk | **All campaigns** | Low | One link |
| Key management | One keypair per campaign, encrypted at rest | None (creator's wallet) | One key, must be highly protected | Complex | Key per batch |
| Demo feasibility | Strong (funding via Nimiq Pay mirrors support) | Poor (creator approval per participant) | Medium | Weak | Medium (no SDK support confirmed) |
| Nimiq Pay fit | Funding reuses existing `sendBasicTransactionWithData`; payout is server broadcast | Every payout opens Nimiq Pay | Same as A | Not in `@nimiq/mini-app-sdk` | Cashlink redemption not in SDK |
| Hackathon judging | Clean "creator-funded, automatic, per-campaign isolated" story | Weak | Sloppy (funds mixed) | Not demoable | Interesting but unproven |
| Later migration path | Straightforward (add HSK/HSM, custody partner) | — | Hard to unbundle | Hard | Possible |

**Repository truth on Nimiq primitives:** the repo has no smart-contract
capability, no multisig, and no cashlink dependency. Available primitives are:
`@nimiq/mini-app-sdk` (`listAccounts`, `sign`, `sendBasicTransaction`,
`sendBasicTransactionWithData` — the last already used by the NIM support
panel), `@nimiq/core` (server-side `KeyPair`, `Address`, `Signature` —
currently used only for signature verification), and the Nimiq RPC adapter
(`src/lib/nimiq/rpc.ts`, today only `getTransactionByHash`, with
`getBlockNumber`/`getBlockByNumber` proven in `rpc-probe.ts`). None of these
imply smart-contract behavior, and the design does **not** claim any.

### Recommendation: **A — Per-campaign isolated reward vault/wallet**

- At campaign creation the server generates a fresh `@nimiq/core` keypair; the
  derived address becomes `vault_wallet`; the private key is encrypted at rest
  (`vault_key_ref`) and never exposed to clients or logs.
- The creator funds the vault from their own Nimiq Pay wallet
  (`sendBasicTransactionWithData`) — the exact interaction already proven by
  NIM support. No custody of the creator's wallet is involved.
- Payouts and refunds are **signed and broadcast server-side** from the vault
  keypair using `@nimiq/core` + the Nimiq RPC (`sendTransaction`), then
  verified by `getTransactionByHash`. This requires adding a `sendTransaction`
  RPC method to `src/lib/nimiq/rpc.ts` (a genuine Nimiq basic-transfer, not a
  smart contract). **Implementation must spike the exact @nimiq/core signing +
  RPC broadcast path first** — the repo has never broadcast from a server key.
- Custody honesty: Votum **does** hold vault keys for the campaign lifetime.
  This is a new, explicit, disclosed responsibility (existing brand copy
  "does not custody funds" refers to the direct support flow and must be
  updated for reward campaigns). Mitigations: per-campaign key, encryption at
  rest, no key export, one-campaign blast radius, documented recovery (see
  §21). A later migration path is HSK/HSM or a custody partner — the per-campaign
  ledger design is unchanged by that.
- **Fallback if custody is unacceptable:** Option B (creator-signed payouts)
  is a thinner, fully non-custodial MVP, at the cost of poor payout UX. It is
  not recommended because 200 payouts = 200 creator approvals.

### Isolated-vault accounting refinement (locked)

**ONE campaign → ONE isolated Nimiq reward address/keypair.**

Accounting **must distinguish** three ledgers that share the same on-chain
vault address:

| Ledger | Meaning | Not |
|--------|---------|-----|
| `reward_principal_luna` | participant reward budget (per × max) | never changes after funding |
| `fee_reserve_luna` | creator-funded operational/network fee budget (D9-B) | not reward budget, not capacity |
| observed on-chain vault balance | raw wallet balance of the vault address | **never used directly** to infer participant rewards |

- **Do not infer available participant rewards from raw wallet balance.** The
  on-chain balance is the sum of principal + fee reserve + excess + any
  transient variance; capacity and rewardsRemaining are derived exclusively
  from `reward_receipts` and `reward_principal_luna`.
- Capacity stays exactly `max_rewarded_participants` regardless of excess fee
  funding (D5/D9).
- Fee reserve is **accounted** via `fee_spent_luna` (confirmed network fees)
  and is **refunded if unused** as part of the creator refund.
- **Fee policy (D9):** creator bears payout/refund network fees; the participant
  receives the exact advertised reward (no deduction). Because repo Nimiq
  tooling (`src/lib/nimiq/rpc.ts`, `@nimiq/mini-app-sdk`) exposes **no dynamic
  gas/fee oracle**, the MVP policy is the simplest truthful one: a **fixed,
  centrally-configured per-transaction fee estimate** (`ESTIMATED_TX_FEE_LUNA`
  domain constant) used to size the fee reserve and to budget broadcasts; the
  actual fee is whatever the chain settles and is observed/confirmed per
  transaction. No on-chain oracle is invented.

---

## 6.1 Key Management Design (MVP server-key boundary)

This is **Votum-custodied reward infrastructure**. It must never be described
or marketed as non-custodial: Votum holds a per-campaign Nimiq private key for
the campaign lifetime and is responsible for its safe keeping.

**Boundary rules (non-negotiable):**

1. **Never store private-key plaintext in normal DB columns.** The key is
   persisted only in encrypted form (`vault_key_ref` references the ciphertext
   + nonce + KDF params; the key material itself is never a column value).
2. **Encryption at rest before persistence.** `@nimiq/core` keypairs are
   serialized, encrypted with a server-only master key (AES-GCM), and only then
   stored.
3. **Encryption master key is server-only.** Sourced from a server environment
   secret (e.g., `REWARD_VAULT_MASTER_KEY`), never a client value, never in the
   repo, never logged.
4. **Never expose the campaign private key to the browser.** No API route, no
   server component, no serialized response carries key material.
5. **Never log private keys.** Logging is redacted; key bytes never enter
   logging paths.
6. **Never put the key in an API response.** Key material is absent from every
   response shape by construction (allowlist serializers + explicit scrub).
7. **Isolate one keypair per campaign.** Key generation creates exactly one
   `@nimiq/core` keypair per campaign; no shared vault key (blast radius = one
   campaign).
8. **Key retrieval only inside the payout/refund server boundary.** The key is
   decrypted only inside the server-side signing function used for payout and
   refund broadcasts — never in request parsing, never in read paths.
9. **Decrypted key exists only as transiently as practical.** The decrypted key
   object is scoped to the signing call and dropped immediately after signing
   (no module-level long-lived decrypted key, no memoization of plaintext).
10. **No key included in public RPCs.** Security-definer DB functions and public
    profile/explore queries never select `vault_key_ref` or any key material.

**Planned module (implementation step, not now):**

```
src/lib/rewards/vault-key.ts     -- generate, encrypt, decrypt, sign-and-drop
  - generateVaultKeypair(): @nimiq/core KeyPair → { address, encryptedBlob }
  - encryptVaultKey(keypair, masterKey) → { ciphertext, iv, authTag }
  - decryptVaultKey(blob, masterKey) → keypair (transient)
  - signVaultTxAndBroadcast(...) → hash  (single boundary that decrypts,
    signs, and discards; never returns the key)
src/lib/rewards/constants.ts     -- MIN_REWARD_PER_PARTICIPANT_LUNA,
                                    ESTIMATED_TX_FEE_LUNA, fee-reserve formula,
                                    payout attempt bound
```

**Testing boundary for the key module:**

- Encryption/decryption round-trip: decrypt(encrypt(k)) === k (unit test).
- Master-key rotation/recovery: documented, tested on a throwaway key.
- No plaintext in DB: a contract test reads the stored `vault_key_ref` blob and
  asserts it is not the raw private key (no prefix match, non-empty ciphertext).
- No key in API/response: contract tests assert key fields are absent from
  every public/creator response shape.
- Sign-and-drop: unit test asserts the decrypt path is scoped and the key is
  not reachable after the signing call returns.
- Broadcast failure: signing produces a valid tx even when the RPC broadcast
  fails (separation of signing from network outcome).

---

## 7. Reward Eligibility (Design Question 4)

**Foundation (all must hold):**

1. Wallet is verified (valid `votum_session` for that wallet).
2. Participation recorded successfully (`poll_votes` row created for
   `poll_id, voter_wallet`).
3. One reward max per wallet per campaign (DB unique `(campaign_id,
   participant_wallet)`).
4. Reward amount independent of selected option.
5. Campaign is `funded` (or `rewarding`).
6. Remaining capacity > 0.
7. Wallet is **not** the campaign creator (D1 — creator participates with full
   voting power but is excluded from reward eligibility).
8. Poll is **public** (`is_public = true AND status IN ('live','closed')`) —
   private polls are never rewarded (D2).
9. `reward_per_participant_luna ≥ MIN_REWARD_PER_PARTICIPANT_LUNA` (D6).

**First-N-until-cap.** Eligible participants are the first `max` wallets whose
participation is confirmed, ordered by the confirmed participation timestamp.
The **ordering source is the DB** (`poll_votes.created_at` / receipt
`created_at`), never a client counter.

**Race at the final slot.** The reward claim is fused into the vote
transaction (see §13): `cast_poll_vote_atomic` (or a companion
`claim_reward_receipt_atomic` called in the same request under the campaign
advisory lock) checks `rewarded_participant_count < max`, inserts the receipt,
and increments the count — atomically. The DB unique `(campaign_id,
participant_wallet)` + advisory lock guarantee exactly one winner.

**Edge cases:**

| Case | Rule |
|------|------|
| Poll creator participating | **May participate/vote normally (one-wallet-one-vote intact); NOT reward-eligible** for their own campaign (D1). Receipt claim is skipped for `voter_wallet = creator_wallet`. |
| Duplicate sessions / reconnect | No effect — identity is the wallet, not the session. |
| Handle/profile changes | No effect — reward keyed to wallet. |
| Wallet reconnect | No effect; session restore (T12 #21) is an independent prerequisite (§20). |
| Private polls | **Never rewarded** (D2). Reward campaigns exist only on public polls; a private poll remains a normal free poll. |
| Closed polls | No new participation; already-eligible receipts still settle after close. |
| Deleted/hidden polls | Campaign requires an existing public poll; deleted/hidden polls resolve via the poll FK/status and are never advertised. |
| Late votes (cap reached) | Participant still votes (free participation) but is **not** rewarded; campaign is `exhausted`, UI says "rewards exhausted". |
| Cancelled campaigns | Before funding: `cancelled`, no rewards, no funds at stake. Funded but no reservation yet: creator may cancel and recover eligible unused funds (D10). After first reservation: terms immutable; creator closes → reconciles → refunds remainder. |
| Wallet A participates, then same wallet votes again (different option) | Impossible — `UNIQUE(poll_id, voter_wallet)` already blocks a second vote; replay returns the existing vote and the existing receipt (idempotent). |

**Reward identity is the immutable wallet identity** — the canonical-hex wallet
column, exactly as `poll_votes.voter_wallet`.

---

## 8. Claim vs Automatic Payout (Design Question 5)

### Options

| Criterion | A. Automatic payout | B. Explicit "Claim NIM" | C. Batched settlement | D. Hybrid |
|-----------|---------------------|-------------------------|-----------------------|-----------|
| UX | Zero-friction ("vote → NIM arrives") | User taps Claim | Delay | Mixed |
| Transaction volume | 1 tx per eligible participant (bounded by cap) | Only claimed receipts (fewer txs) | Fewest (batch) | Variable |
| Nimiq Pay visibility | Payout happens server-side; user sees balance change | User re-enters Nimiq Pay to claim | None until arrival | Depends |
| Failure recovery | Retry queue per receipt | Retry on claim | Reconciliation job | Per-path |
| Cost | Pay per participant (creator pays fees) | Fewer payouts → lower fees | Lowest | — |
| Abuse resistance | Reward immediately attached to real participation | Claim adds a hop | Same as A | — |
| Implementation complexity | Low (reuse support confirm loop) | Medium (claim gate + expiry) | High (scheduler) | High |
| Demo strength | **Strong** — "participate and get rewarded" is instant and magical | Good but adds friction | Weak (delay) | — |

**Decision (LOCKED — D3): A — automatic payout after confirmed participation.**

- The reward is the moment of participation. Automatic payout makes the value
  proposition instant and demoable, eliminates unclaimed-funds expiry (no
  "expired/unclaimed" state for MVP), and reuses the exact observe-and-confirm
  pattern proven in NIM support.
- Implementation: on `cast_poll_vote_atomic` success for a funded campaign with
  capacity, the server claims a receipt (`eligible`), immediately starts a
  payout attempt from the vault, and records the outcome. Failure → the receipt
  stays `retryable` and is retried (see §9).
- **There is NO participant Claim button in V2B.2** (D3). The user never
  reveals their selected option to claim — there is no claim action at all;
  payout is keyed to the wallet + poll only.
- Participant receives the **exact advertised reward**; network fees are borne
  by the creator from the fee reserve (D9).

---

## 9. Reward Receipts (Design Question 6)

**A truthful reward ledger** with per-wallet lifecycle state:

```
eligible → reserved → payout_pending → paid
                        └──► failed → retryable → payout_pending
```

- `eligible` — participation recorded, capacity available, receipt created
  atomically with the vote.
- `reserved` — the reward slot is taken; balance holds it. (MVP may merge
  `eligible`/`reserved` — kept distinct to make the cap race auditable.)
- `payout_pending` — a payout attempt is in flight (broadcast not yet
  confirmed).
- `paid` — terminal; payout transaction confirmed on chain.
- `failed` — broadcast/observation failed; no funds moved.
- `retryable` — can be retried; unique `(receipt_id, attempt_number)` and the
  guarded `eligible→…→paid` transition mean a receipt can never be paid twice.
- `expired/unclaimed` — **not needed in MVP** (automatic payout; no claim). If
  a claim path is later chosen, this state is added then.

**Uniqueness / idempotency:**

- `reward_receipts`: `UNIQUE (campaign_id, participant_wallet)` — a wallet can
  never receive the same campaign reward twice.
- `reward_payout_attempts`: `UNIQUE (receipt_id, attempt_number)` and the
  payout `transaction_hash` is partial-unique against the whole ledger (one
  hash used once).
- Transitions are guarded security-definer updates: only `eligible`/`reserved`
  → `payout_pending`, only `payout_pending` → `paid` (with a matching
  confirmed hash), etc.

**Receipt proof:** "wallet X participated in poll Y and received Z NIM".
The receipt row joins campaign → poll and stores amount, status, confirmed
payout hash, and timestamps. It stores **no `option_id`** anywhere — the
receipt cannot reveal which option was selected. Payout memos reference the
campaign/receipt, never the option.

---

## 10. Creator Refunds (Design Question 7)

**When the remainder becomes refundable:** after the poll is `closed` (or the
campaign is `cancelled` per D10) and all eligible receipts are settled (`paid`
or terminal `failed` with no retry pending). Remainder = confirmed funding
− confirmed paid principal − confirmed fees spent (vault balance truth,
reconciled against the funding/payout/refund ledgers). The remainder includes
unused reward principal, unused fee reserve, and any refundable excess (D5).

**Who can initiate:** the campaign creator (verified session, wallet must match
`creator_wallet`). Creator wallet changes are **not allowed** to redirect
ownership — identity and refund destination are the immutable
`creator_wallet`.

**Explicit, creator-initiated (LOCKED — D4):** refund happens only when the
creator explicitly requests it, and only when:

- the campaign is `closed`/`cancelled` per policy (D10), **and**
- there are **no unresolved reserved / payout_pending rewards** that could
  still consume campaign principal.

There is **no automatic timed refund** in V2B.2.

**Refund lifecycle:**

```
pending → confirmed | failed → retryable
```

- **Blocked while payouts are pending:** the refund RPC refuses if any receipt
  is in `reserved`/`payout_pending`/`retryable`. Reconciliation first settles
  or finalizes those.
- **Partial payout failures:** failed receipts are retried (up to a bounded
  attempt count) before refund; if a receipt is final-failed (no funds moved),
  its reserved amount is simply not paid and flows into the remainder. No
  over-refund: refund amount is computed from confirmed-paid receipts only.
- **Fee reserve (D9):** unused fee reserve is refunded with the remainder;
  `fee_spent_luna` records confirmed network fees actually paid.
- **Rounding/dust:** all arithmetic is integer Luna; remainder = funding −
  paid − fees. The `MIN_REWARD_PER_PARTICIPANT_LUNA = 1000` (0.01 NIM) floor
  (D6) prevents dust-y payouts; dust below 1 Luna cannot exist by construction.
- **Transaction proof:** refund rows record the bound/confirmed hash, block,
  timestamp — same observe-and-confirm pattern.
- **Idempotency:** one active refund per campaign; a second refund attempt
  returns `replay`; the refund hash is partial-unique.

---

## 11. Abuse / Sybil Boundary (Design Question 8)

V2B.2 does **not** pretend "verified wallet = unique human".

**MVP protections (built-in):**

- One reward per wallet per campaign (DB unique).
- One vote per wallet per poll (existing `UNIQUE(poll_id, voter_wallet)`).
- Creator may participate but is **not reward-eligible** for their own campaign
  (D1) — voting power unchanged.
- Reward only for real, confirmed participation in a **public** poll (D2).
- No outcome/majority linkage, so "reward-maximizing" cannot change any
  financial outcome.
- Cap race resolved atomically by the DB; no client-counter trust.
- Funding verified from chain (recipient/amount/memo/networkId), not client
  callback; sender deliberately not required.
- Payouts only from the campaign vault, only to receipt wallets, only while
  funded/within capacity.
- Fee reserve is creator-funded and never inflates reward capacity or
  rewardsRemaining (D9).

**Honest boundary — V2B.2 does NOT prevent:**

- Wallet farming (one person, many wallets) — each farmed wallet participates
  and earns like any other. Votum's identity is "verified wallet", not "unique
  human".
- Many wallets controlled by one person participating normally.
- Scripted participation from many wallets.
- Repeated reconnect/session generation (does not multiply rewards — same
  wallet, same vote, same receipt).
- Funding manipulation of a *single* campaign is bounded by the vault ledger;
  a malicious creator can still create many small campaigns (cost is the NIM
  they commit).
- A creator funding their own campaign is allowed (their money, their vault);
  they may participate but are excluded from their own reward pool (D1).

**Deferred to later identity/reputation layers** (explicitly out of V2B.2):
reputation scoring, social graph, advanced Sybil detection, device/bio
fingerprinting, captcha, referral gates, streaks, leaderboards. V2B.2 is not
identity infrastructure; it must not overbuild.

---

## 12. Public Poll UX (Design Question 9)

**Truthful information shown on a rewarded poll (only when `funded`):**

- "Earn X NIM for participating" — badge in the poll header, using NIM Blue
  (informational/proof), paired with text + icon (never colour alone; DESIGN.md
  rule). Signal Gold remains the single CTA colour.
- "X of N rewards remaining" — derived from the DB (`rewarded_participant_count`
  vs `max`), never a client counter.
- Funding state as a status chip: "Rewards funded" (funded) / "Rewards
  exhausted" (exhausted) / nothing (configured/funding pending — **no reward
  CTA**).
- After participation + payout: "You earned X NIM for participating" with a
  link to the reward receipt (which proves wallet, poll, amount — and no
  option).
- If the user already voted and the receipt is `retryable`: "Your reward is
  being sent — we'll retry."

**What public users see about amounts (LOCKED — D7):**

| Field | Public? | Note |
|-------|---------|------|
| Reward per participant | **Yes** | It is the campaign's advertised offer. |
| Max participants | **Yes** | Part of the offer. |
| Rewards remaining | **Yes** | Count, derived from receipts. |
| Total participant reward budget (principal) | **Yes** | `reward_principal_luna`, displayed as "X NIM reward pool". |
| Funded / availability state | **Yes** | "Rewards funded" / "Rewards exhausted". |
| Paid amount (cumulative) | **No — creator only** | Public sees remaining count, not cumulative payouts. |
| Pending amount / refundable amount | **No — creator only** | Creator management surface only. |
| Funding transaction state, payout failures, refund state | **No — creator only** | Creator management surface only. |
| Payout tx IDs | **No (receipt page only)** | Keeps the page lightweight and clean. |
| Vault key material / encrypted ciphertext / auth-session data | **Never** | Structurally excluded from every public surface. |
| Chosen vote options | **Never** | Everywhere. |

**No reward CTA on an unfunded campaign** — a hard rule (Safety rule 3). If the
campaign is `configured`/`funding_pending`/`cancelled`, the poll renders as a
normal free poll.

---

## 13. Explore (Design Question 10)

**Minimum V2B.2 additions — additive only, no redesign of V2A Explore (LOCKED — D8):**

1. **Rewarded filter** — a binary toggle in the existing filter set
   (`ExploreFilterState.rewarded: boolean`), applied in the server query layer
   (`explore-queries.ts`) as `EXISTS (reward_campaigns WHERE poll_id = polls.id
   AND status IN ('funded','rewarding'))`. Backward compatible: absent →
   today's behaviour.
2. **Reward badge/amount on rewarded poll cards** — a small NIM Blue badge on
   cards whose campaign is `funded`/`rewarding` with capacity, showing the
   reward-per-participant amount. `PollCardData` gains an optional
   `rewarded: boolean` and `rewardPerParticipantLuna`. No new card layout.
3. **Compact "Earn NIM" discovery section** — a small, bounded strip at the top
   of the Explore results (or a lightweight filtered view) surfacing
   rewarded, funded polls. It reuses the existing query layer and
   `PollCard`; it is **not** a new pagination/sort system.

**Not added (D8):** reward sorting, reward leaderboard, or any Explore redesign.
V2A filter/pagination/search semantics remain intact.

The Explore `PollCardData` contract keeps excluding private fields
(`destinationWallet`, contribution mode, etc.); it adds only the truthful
reward surface (funded + per-participant offer).

---

## 14. Creator UX (Design Question 11)

From `/my-polls/[pollId]` and a new `/my-polls/[pollId]/rewards` surface, the
creator can inspect, all derived from the DB:

- Funding state (`configured` / `funding_pending` / `funded` / …)
- Required funding, principal, fee reserve, funded amount (exact)
- Reward per participant, max participants, rewards remaining
- **Paid amount** (`paid_amount_luna`, principal), **pending amount**
  (unresolved reserved/payout_pending), **refundable amount** (incl. unused fee
  reserve + excess), **fee spent** (D7/D9)
- **Funding transaction state** (submitted/confirmed/rejected, hashes)
- **Payout failures** (retryable receipts) with retry action
- **Refund state** + transaction proof
- **Cancel action** when allowed (D10: `funded` with no first reservation yet)
  — recovers eligible unused funds; hidden/disabled once the first reward
  reservation exists.

**Immutability (LOCKED):** reward configuration (`reward_per_participant_luna`,
`max_rewarded_participants`, `reward_principal_luna`, `fee_reserve_luna`,
`total_budget_luna`, `poll_id`, `creator_wallet`, `vault_wallet`) becomes
**immutable once the first reward reservation exists** (`first_reservation_at IS
NOT NULL`), per D10 and the core promise. Before that (D5), even a confirmed
over-funding cannot change terms. The only mutable fields are lifecycle state
and derived balances. Immutability is enforced server-side in the update RPC
(no client-only rule).

---

## 15. Participant Profile (Design Question 12)

Replace the V2B.1 `nimEarnedLuna = '0'` placeholder with **confirmed paid
ledger truth**:

- **Total NIM earned:** `sum(reward_receipts.amount_luna)` where status =
  **`paid` only** and `participant_wallet = _w` (public poll boundary: join
  campaign → poll, `is_public = true AND status IN ('live','closed')`).
  **Eligible, reserved, pending, and failed receipts never count** (locked).
  Public by default (privacy §16 allows it).
- **Recent reward history:** add a `reward` kind to the activity RPC:
  `{ kind: 'reward', pollId, question, amountLuna, at }` — poll title only,
  **no option**, matching the existing `created`/`participated` privacy rule.
- **Fee reserve never counts toward NIM earned** (D9): `paid_amount_luna`
  counts principal only; the fee reserve and `fee_spent_luna` are invisible to
  the participant profile.
- **Public vs private visibility:** totals + recent rewards are public (like
  NIM supported). Exact campaign-level funding details and payout tx IDs stay
  on the reward receipt page, not the profile — keep the profile lightweight.
- **Campaign reward amounts:** reward-per-participant is public (the offer);
  cumulative paid is creator-view only.
- **No chosen-option leakage:** the profile query and serializers never select
  `option_id` (existing allowlist architecture extended; see §17).

The profile RPC `get_participant_public_profile` changes its hardcoded
`'0'` to a real `SUM(...)` over paid receipts (see §15/§17 for exact SQL
boundary). Stats stay derived — never stored on the profile.

---

## 16. Data Model (Design Question 13)

**Recommended minimal schema — 5 tables** (all additive, RLS-enabled,
service_role-gated, public reads via security-definer functions):

### 16.1 `reward_campaigns` — one per poll

- **Purpose:** the campaign offer + lifecycle + balances.
- **Columns:** see §4 (`id`, `poll_id UNIQUE FK polls`, `creator_wallet`,
  `reward_per_participant_luna`, `max_rewarded_participants`,
  `reward_principal_luna`, `fee_reserve_luna`, `total_budget_luna`,
  `asset` CHECK='NIM', `status`, `funded_amount_luna`,
  `refundable_excess_luna`, `rewarded_participant_count`, `paid_amount_luna`,
  `fee_spent_luna`, `refundable_amount_luna`, `first_reservation_at`,
  `vault_wallet`, `vault_key_ref`, timestamps).
- **CHECKs:** `reward_per_participant_luna >= MIN_REWARD_PER_PARTICIPANT_LUNA`
  (application-layer constant mirrored in the migration),
  `max_rewarded_participants > 0`,
  `reward_principal_luna = reward_per_participant_luna * max_rewarded_participants`,
  `fee_reserve_luna >= 0`, `total_budget_luna = reward_principal_luna + fee_reserve_luna`,
  `funded_amount_luna >= 0`, `paid_amount_luna >= 0`,
  `rewarded_participant_count >= 0 AND <= max`,
  `fee_spent_luna >= 0`, `refundable_excess_luna >= 0`,
  `refundable_amount_luna >= 0`, `paid_amount_luna + fee_spent_luna <= funded_amount_luna`.
- **Unique:** `poll_id` UNIQUE (one campaign per poll).
- **FK:** `poll_id → polls(id)`.
- **Security:** RLS enabled, `REVOKE ALL FROM anon, authenticated`, service_role
  `SELECT, INSERT, UPDATE` (no DELETE). Public reads via a security-definer
  function returning only the allowed surface (offer, funded state, remaining
  count, per-participant amount, total reward principal).

### 16.2 `reward_funding_transactions` — creator funding attempts

- **Purpose:** bind → observe → confirm lifecycle for the prepaid funding
  (principal + fee reserve; mirrors `nim_support_intents`).
- **Columns:** `id`, `campaign_id FK`, `creator_wallet`, `reference` UNIQUE,
  `submitted_transaction_hash` (partial unique), `confirmed_transaction_hash`
  (partial unique), `amount_luna` (observed amount), `status`
  (`submitted|confirmed|rejected`), `confirmation_deadline`, `block_number`,
  `transaction_timestamp`, `confirmed_at`, timestamps.
- **Unique/FK:** `reference` UNIQUE; partial-unique hashes (one hash used
  once); `campaign_id → reward_campaigns(id)`.
- **Security:** RLS + REVOKE anon/authenticated; service_role CRUD via the
  funding RPCs only.

### 16.3 `reward_receipts` — per-wallet entitlement ledger

- **Purpose:** prove "wallet X participated in poll Y and received Z NIM";
  reward-cap accounting; **never stores `option_id`**.
- **Columns:** `id`, `campaign_id FK`, `poll_id FK`, `participant_wallet`,
  `amount_luna`, `status` (`eligible|reserved|payout_pending|paid|failed|retryable`),
  `created_at` (= confirmed participation time; ordering source for first-N),
  `paid_at`.
- **Unique/FK:** `UNIQUE (campaign_id, participant_wallet)` (one reward max);
  FKs to `reward_campaigns(id)` and `polls(id)`.
- **Security:** RLS + REVOKE anon/authenticated; service_role only. The
  participant's own receipts are readable via an authenticated endpoint
  (`GET /api/me/rewards`) that returns only their own wallet's rows.

### 16.4 `reward_payout_attempts` — execution/retry log

- **Purpose:** idempotent retry of vault→participant broadcasts; audit trail.
- **Columns:** `id`, `receipt_id FK`, `attempt_number`, `status`
  (`pending|confirmed|failed|retryable`), `transaction_hash` (partial unique),
  `error_code`, `broadcast_at`, `confirmed_at`.
- **Unique/FK:** `UNIQUE (receipt_id, attempt_number)`; partial-unique
  `transaction_hash` against the whole payout ledger.
- **Security:** RLS + REVOKE anon/authenticated; service_role only.

### 16.5 `reward_refunds` — creator refund events

- **Purpose:** prove remainder returned to `creator_wallet`.
- **Columns:** `id`, `campaign_id FK`, `creator_wallet`, `amount_luna`,
  `status` (`pending|confirmed|failed|retryable`), `transaction_hash` (partial
  unique), `block_number`, `transaction_timestamp`, `confirmed_at`.
- **Unique/FK:** one active refund per campaign (partial unique on
  `campaign_id WHERE status IN ('pending','confirmed')` for simplicity, or a
  single `campaign_id` UNIQUE row updated in place); FK to
  `reward_campaigns(id)`.
- **Security:** RLS + REVOKE anon/authenticated; service_role + creator-gated
  initiation (the refund RPC checks the session wallet against
  `creator_wallet`).

**Deliberately not created (can be derived):** no `reward_balances` table
(derived from campaign columns), no per-option reward rows, no `users`
table, no activity-feed table.

**Status representation:** `text` + CHECK constraints — the repo convention
(no `CREATE TYPE` enums anywhere; `nim_support_intents.status` and `polls.status`
are text+CHECK).

---

## 17. Concurrency / Money Safety (Design Question 14)

**All financial transitions are single security-definer function bodies**
(one implicit transaction each), following the `publish_poll_atomic` /
`cast_poll_vote_atomic` / `confirm_nim_contribution_atomic` precedent. UI
counters are display-only.

| Hazard | Defense |
|--------|---------|
| Two users take the final reward slot | Campaign advisory lock (`pg_advisory_xact_lock` on a deterministic key from `campaign_id`) + capacity check + `rewarded_participant_count` increment inside one atomic claim; `UNIQUE(campaign_id, participant_wallet)` backstop. |
| Duplicate vote requests | Existing `UNIQUE(poll_id, voter_wallet)` + `cast_poll_vote_atomic` advisory lock; reward claim keyed to the same vote (replay returns the same receipt). |
| Duplicate payout requests | `UNIQUE(receipt_id, attempt_number)`; only `payout_pending` may become `paid`; guarded transition. |
| Payout success but DB timeout | Observe chain by hash first; the receipt can only be marked `paid` when a confirmed tx is recorded. If the DB write timed out, the observer re-checks the hash (idempotent). |
| DB success but broadcast failure | Payout attempt row `failed` before the balance changes; no receipt leaves `eligible/reserved` to `paid` without a confirmed hash. |
| Duplicate transaction observation | Partial-unique hash rows in funding/payout/refund ledgers; a hash used once anywhere is `transaction_already_used`. |
| Creator refund races with payout | Refund RPC requires no receipt in `reserved`/`payout_pending`/`retryable`; reconciliation settles first; refund amount computed from confirmed-paid + confirmed-fee only. |
| Campaign overspending | `paid_amount_luna + fee_spent_luna` guarded `<= funded_amount_luna`; payout only while capacity remains; receipt amount fixed at claim. |
| Fee reserve exhausted mid-campaign | Fee reserve tracked in `fee_spent_luna`; a payout broadcast that would exceed the reserve is deferred/failed as `fee_reserve_insufficient` and surfaced to the creator for a top-up (D9). A payout is never attempted with no fee coverage. |
| Underfunded campaign advertised as funded | `funded` is set only by the confirmed funding RPC (recipient/amount ≥ total/memo/networkId verified); the advertisement query checks campaign status server-side. |
| Cancel-after-funding races with first reservation (D10) | Cancel RPC runs under the campaign advisory lock and requires `rewarded_participant_count = 0`; the reservation claim sets `first_reservation_at` atomically — one boundary wins, no window. |
| Stale client reward counters | All reward figures (remaining, paid, exhausted) are recomputed server-side per request from the ledger; no counter stored on the client. |

---

## 18. NIM Units (Design Question 15)

**Integer smallest units everywhere** — the repo's established convention:

- `1 NIM = 100,000 Luna` (`LUNA_PER_NIM = 100000n`, `src/lib/nimiq/units.ts`).
- DB columns: `amount_luna`, `min_nim_luna` (existing), new columns all
  `bigint ... luna`.
- Input: `nimDecimalToLuna(value: string)` — strict canonical parser (no
  signs/commas/exponents, max 5 decimals, **no rounding** — excess precision is
  an error).
- Display: `lunaToNim` / `formatNimAmount` ("X NIM") — float only at the UI
  boundary.
- **Reward-per-participant arithmetic:** `perLuna = nimDecimalToLuna("0.5") =
  50000n`. Stored integer. Payout value = `perLuna` exactly.
- **Minimum reward constant (D6):** `MIN_REWARD_PER_PARTICIPANT_LUNA = 1000n`
  (0.01 NIM) — a single centralized product/domain constant (e.g., in
  `src/lib/nimiq/units.ts` alongside `LUNA_PER_NIM`, or a dedicated
  `src/lib/rewards/constants.ts`). Used by the create form, the publish RPC
  validation, and the campaign CHECK. **No scattered numeric literals.**
- **Fee estimate constant (D9):** `ESTIMATED_TX_FEE_LUNA` — a single
  centralized constant for the MVP per-transaction network-fee estimate used to
  size the fee reserve and gate broadcasts. Actual fees are observed from the
  chain per transaction.
- **Budget arithmetic:** `reward_principal_luna = perLuna × max`;
  `total_budget_luna = reward_principal_luna + fee_reserve_luna` (bigint;
  bounded by `PG_BIGINT_MAX`, and the mini-app SDK needs `Number ≤
  MAX_SAFE_INTEGER` — validated at funding time like the support amount).
- **Rounding policy:** none in storage — integer everywhere; the only rounding
  in the codebase is the deprecated display-only `nimToLuna`. Dust cannot exist
  below 1 Luna by construction; the 0.01 NIM minimum (D6) prevents dust-y
  payouts.

---

## 19. Privacy (Design Question 16)

Preserve V2B.1 privacy exactly.

**Publicly knowable:**

- wallet participated (already public via profile activity)
- wallet received reward (total + recent reward activity)
- reward amount (per-participant offer public; per-wallet earned public)

**Must remain private (structural):**

- selected option — never in receipts, payout memos, profile stats/activity,
  or any reward query.

**Confirmation that no reward query joins or exposes chosen-option data:**

- `reward_receipts` has **no `option_id` column** and no `poll_options` FK.
- `reward_payout_attempts` and `reward_refunds` reference receipt/campaign
  only.
- The public profile RPC's reward branch joins `reward_receipts → 
  reward_campaigns → polls` and selects only `polls.question` + amounts —
  never `poll_votes.option_id` and never `poll_options`.
- The serializer allowlist pattern (`src/lib/profiles/serialize.ts`) is
  extended: new keys are `{ kind:'reward', pollId, question, amountLuna, at }` —
  no option fields by construction.
- Payout memos are `votum-reward:<receiptId>` (or campaign id) — no option
  reference. Receipt page proves wallet+poll+amount only.

---

## 20. Failure Recovery (Design Question 17)

Recover from **chain truth** (RPC observation), not client callback truth —
the same philosophy as the NIM support confirm loop.

| Failure | State | Recovery |
|---------|-------|----------|
| Funding rejected in Nimiq Pay | no funding row / `submitted` cleared | clean `configured`/`funding_pending`; creator retries. |
| Funding broadcast but not confirmed | funding row `submitted`, deadline in future | re-observe `getTransactionByHash` on retry (client resumes via pending-local-storage like `votum_pending_nim_support_v1`). |
| Funding confirmed but app didn't observe immediately | funding row still `submitted` | retry observation; on confirmed hash → `confirmed`, campaign `funded`. Replay-safe via partial-unique hash. |
| Payout rejected/broadcast failure | payout attempt `failed` | receipt stays `reserved`/`eligible`; retryable attempt incremented; bounded retries. |
| Payout pending | `payout_pending` | re-observe by hash; confirm → `paid`. |
| Payout failed (permanent) | `failed` after retries | reserved amount returns to remainder at refund reconciliation; no double pay. |
| Payout confirmed but app missed callback | `payout_pending` | reconciliation job re-checks the stored hash; marks `paid`. |
| Fee reserve insufficient (D9) | broadcast gated, payout attempt `failed` (`fee_reserve_insufficient`) | receipt stays retryable; creator is notified to top up the fee reserve; no payout attempted without fee coverage. |
| Refund pending/failed | refund `pending`/`failed`/`retryable` | re-observe the refund hash; on confirm → `confirmed`. |
| DB write after chain confirm (edge) | conflicting states | guarded transitions + unique hashes make the observer idempotent; a background reconciliation pass derives truth from confirmed hashes. |

The reconciliation job (a server cron/route invoked by the app, matching the
support confirm loop) is **derive-from-chain** — it never trusts a client.
For each of funding, payout, and refund, the pipeline is strictly
`INTENT → BROADCAST → CHAIN OBSERVATION → DB CONFIRMATION`; client callbacks
are never financial truth.

---

## 21. MVP Boundary (Design Question 18)

**V2B.2 MVP does NOT include:** Cashlinks, reputation scoring, social graph,
advanced Sybil detection, multi-token rewards, USDC, creator teams, recurring
campaigns, NFT rewards, outcome predictions, leaderboards, streaks, referral
rewards, arbitrary reward formulas, custom reward tiers per option, per-poll
multiple campaigns. None are required by repository constraints.

---

## 22. Migration / Backward Compatibility (Design Question 19)

- **No reward campaign row → exactly today's poll behaviour.** All additions
  are new tables/functions/columns on `reward_*` only. No existing table is
  altered; no existing column/row changes.
- `polls`, `poll_votes`, `nim_*`, `participant_profiles`, sessions, receipts,
  My Polls, Explore, publish — all unchanged. A poll without a campaign is a
  normal free poll (reward surface hidden by query-time absence).
- Existing profiles/votes/support history remain valid; `nimEarnedLuna` only
  changes from `'0'` to a real sum for wallets with paid receipts (others stay
  `'0'`).
- One additive profile migration step extends the public profile RPC's stats +
  activity to include reward-derived numbers — still additive, still derived,
  still allowlisted.
- Rollout rule: migration lives on the feature branch only; **no `supabase db
  push`, no link, no hosted Supabase changes, no deploy, no merge to main** in
  this or the implementation step.

---

## 23. MVP Exclusions (Design Question 18 restated as a boundary)

- Cashlinks / HTLC / multisig / smart contracts (no repo/SDK support).
- Public-choice polls; rewards never reveal choice.
- Claim-with-expiry, unclaimed balances.
- Multiple campaigns per poll, custom tiers, formula-based rewards.
- Any change to the voting rule or fairness model.
- Identity/reputation infrastructure beyond the honest boundary in §11.

---

## 24. Security Risks

| Risk | Mitigation |
|------|-----------|
| Vault key theft (custody) | Per-campaign key, encryption at rest (server-only master key), no export, one-campaign blast radius, documented key lifecycle; migration path to HSK/HSM. Votum-custodied infrastructure — never called non-custodial. |
| Reward-cap race manipulation | DB advisory lock + unique receipts; no client trust. |
| Double payout | Unique hashes + guarded `→ paid` transitions + payout attempt log. |
| Underfunded advertised as rewarded | `funded` set only by confirmed chain observation (amount ≥ total); advertisement gated on DB status. |
| Forged funding (client lies about payment) | Chain verification of recipient/amount/memo/networkId; sender deliberately not required (consistent with support). |
| Creator self-reward / farmed wallets | Creator excluded from own reward pool (D1); farmed wallets earn like any wallet (honest boundary, §11); no overbuild. |
| Option-leak through rewards | No option_id in any reward table, memo, profile, or API shape; allowlist serializers. |
| Refund misdirection | Refund destination = immutable `creator_wallet`; session must match; no wallet-redirect. |
| Nonce/fee manipulation on broadcasts | Server-side signing with fixed fee policy; observe+confirm before state change; retry bounded; fee reserve never exceeds creator-funded amount. |
| Fee-reserve drain / top-up abuse | Fee reserve is creator-funded, capped at `fee_reserve_luna`; spend tracked in `fee_spent_luna`; payouts gated on coverage. |
| Excessive transaction volume / fee drain | Cap on participants, bounded retries, explicit fee policy (creator pays; D9). |
| UI counter divergence | All reward figures server-derived; no client counters as truth. |
| Terms changed under participants (rug) | Immutability enforced once `first_reservation_at` set (D10 + core promise); server-side RPC guard, no client-only rule. |
| Key leakage via logs/API/browser | Key material never logged, never in API responses, never sent to browser; decryption transient inside payout/refund boundary only. |

---

## 25. Open Questions (genuine product decisions)

All ten design questions from the V2B.2 design step are now **locked** by
D1–D10:

| Former question | Resolution |
|-----------------|-----------|
| OQ-1 Creator self-participation | **D1** — participates, not reward-eligible |
| OQ-2 Private polls | **D2** — public polls only; private rewards deferred |
| OQ-3 Payout delivery | **D3** — automatic payout, no Claim button |
| OQ-4 Refund timing | **D4** — explicit creator-initiated only |
| OQ-5 Overpayment | **D5** — creator-owned refundable excess; terms immutable |
| OQ-6 Minimum reward | **D6** — 0.01 NIM = 1,000 Luna, centralized constant |
| OQ-7 Public budget visibility | **D7** — total reward principal is public |
| OQ-8 Explore depth | **D8** — filter + badge + compact Earn NIM section |
| OQ-9 Fee policy | **D9** — creator bears fees; fee reserve separate |
| OQ-10 Cancel after funding | **D10** — allowed before first reservation; immutable after |

**Remaining genuine decisions for implementation (non-blocking, product input
during implementation):**

- **Fee-reserve sizing policy:** exact formula for `fee_reserve_luna` given
  `ESTIMATED_TX_FEE_LUNA` (e.g., `estimatedFee × maxParticipants × safety
  multiplier`). Default proposal in the plan; adjust at implementation.
- **Payout attempt bound:** maximum retries per receipt before it is marked
  final-failed and excluded from payout (default in plan).
- **Earn NIM section placement/limit:** exact placement and count for the
  compact Explore strip (default in plan).

---

## 26. Recommended V2B.2 Implementation Slices (sequencing only — no plan)

> These are suggested work slices for the implementation plan (companion doc),
> not an implementation plan. Nothing is built now. The plan checkpoint list in
> the companion document follows the same boundaries (V2B.2.1–V2B.2.14).

1. **Slice 0 — Spike:** verify server-side `@nimiq/core` keypair → sign a
   basic NIM transaction → broadcast via Nimiq RPC `sendTransaction` →
   observe by hash. Gate for the whole custody approach.
2. **Slice 1 — Schema + contracts:** the 5 reward tables, CHECKs, unique
   constraints, security-definer functions, grants; `v2b2-*` contract tests.
3. **Slice 2 — Funding flow:** configure reward in create (D6 min, D9 fee
   reserve); funding intent/bind/observe/confirm; publish gate
   (`reward_funding_required`); overpayment (D5) and cancel-before-reservation
   (D10).
4. **Slice 3 — Eligibility + claims:** reward receipt fused into the vote
   transaction; cap race; creator exclusion (D1); public-polls-only (D2);
   `first_reservation_at` immutability boundary (D10); exhausted/late-vote
   semantics.
5. **Slice 4 — Automatic payouts:** vault signing, broadcast, observe,
   receipt lifecycle, fee reserve (D9), retry/reconciliation job.
6. **Slice 5 — Refunds:** close reconciliation, explicit creator refund (D4),
   remainder (principal + fee reserve + excess), idempotency, proofs.
7. **Slice 6 — Public UX:** reward badge + remaining count + exhausted state +
   reward receipt page on the poll; D7 transparency.
8. **Slice 7 — Explore:** rewarded filter + PollCard badge/amount + compact
   Earn NIM section + `PollCardData` extension (D8).
9. **Slice 8 — Creator UX:** reward management surface in My Polls + immutable
   config (D10) + refund/cancel actions.
10. **Slice 9 — Profile:** reward stats (paid only) + reward activity kind +
    allowlist extension.
11. **Slice 10 — Full gate:** V2B.2 suites + all V2A/V2B.1 suites + typecheck +
    lint + build + device QA, then independent #21 HTTPS retest as a
    prerequisite (§27).

---

## 27. #21 HTTPS Follow-up (Design Question 20)

V2B.1's single remaining production-verification item is carried **unchanged**
into the rollout checklist as an **independent prerequisite before production
verification**:

> **T12 #21 — same-wallet reconnect/session restore over HTTPS.** Local HTTP
> host limitation (Nimiq Pay iOS WebView does not persist the `votum_session`
> cookie after Mini App close/reopen over local HTTP). Not a Votum code bug; no
> auth weakening applied. HTTPS retest required on a secure production origin.

V2B.2 does **not** fix or redesign it. Reward settlement depends on session
integrity, so this retest gates production rollout but not V2B.2 development.

---

## 28. Self-Review

- **Outcome-linked rewards?** No — fixed per-participant reward, no option/
  winner/majority linkage anywhere in schema, RPC, memos, or UI. Brand
  vocabulary (signal/support/contribution, never bet/odds/pot/payout-on-winner)
  preserved.
- **Fake balances?** Every figure derived from the ledger at read time; `funded`
  only from confirmed chain observation; zero is truthful zero.
- **One-wallet-one-vote preserved?** Yes — untouched; rewards attach to the
  existing vote uniqueness; creator participation keeps full voting power (D1).
- **Privacy preserved?** Reward receipts carry no `option_id`; profile activity
  adds `reward` kind with poll title only; allowlist serializers extended;
  NIM earned counts confirmed paid only.
- **Money safety?** Integer Luna only; atomic security-definer transitions;
  unique hashes; guarded state machines; chain-truth reconciliation; fee
  reserve never counted as reward money (D9).
- **Backward compatible?** Additive tables/functions only; no-campaign poll =
  today's behaviour; existing history valid.
- **MVP bounded?** No cashlinks/reputation/social/multi-token/leaderboards/
  formulas (§23); Explore additions additive (D8).
- **Decisions consistent?** D1–D10 locked and integrated (§0.1 + each section);
  no contradictory OQ remains.
- **Custody disclosed?** Votum-custodied reward infrastructure, explicitly
  documented as custodial (§6.1); never called non-custodial.
- **#21 carried forward?** Yes (§27), as an independent HTTPS prerequisite.

---

## Completion Criteria (for the future implementation step)

V2B.2 is complete when:

- Campaign lifecycle states are exactly as specified and truthfully surfaced
- Rewarded polls are advertised only when funded; no fake reward CTA
- Reward is per-participant, outcome-independent, one-reward-per-wallet-per-campaign
- Creator participates but is not reward-eligible (D1); private polls never
  rewarded (D2)
- Automatic payouts settle with idempotent retry; no double pay, no cap race;
  participant receives the exact advertised reward (D3, D9)
- Fee reserve is funded, accounted, and never counted as reward budget or NIM
  earned (D9)
- Refund is explicit, creator-initiated, and blocked while rewards are
  unresolved (D4); over-funding is creator-owned refundable excess (D5)
- Minimum reward constant is centralized (D6); public transparency per D7;
  Explore additions additive per D8
- Terms are immutable once the first reward reservation exists (D10 + core
  promise)
- Public poll + Explore + creator + profile surfaces per spec
- All V2B.2 + V2A + V2B.1 suites pass; typecheck/lint/build pass; device QA done
- #21 HTTPS retest carried into the rollout checklist as an independent
  prerequisite
- No hosted Supabase changes, no deploy, no merge to main
