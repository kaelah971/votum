# V2C.0 Campaign Integration Readiness Audit

**Status:** Audit only. No Campaign implementation or schema change.
**Branch:** `feat/v2-participation-record`
**Audited HEAD:** `f40e142 feat(v2b2): reconcile reward payouts onchain`
**Scope:** Static inspection of the V2B.2 engine, migrations, services, APIs,
wallet/session primitives, Poll coupling, and the recorded V2C roadmap.

## Executive Verdict

The finished V2B.2 money engine is safe to reuse as a **settlement engine**, but
it is not a standalone Campaign engine yet.

The current `reward_campaigns` record is a Poll reward adapter, not a general
Campaign entity:

- `reward_campaigns.poll_id` is required, foreign-keyed to `polls`, and unique.
- Funding initiation requires a public Poll.
- Reservation derives eligibility from `poll_votes` and the Poll economic model.
- The vote route performs automatic reservation and payout after voting.
- Public reward reads and current reward APIs are Poll-ID based.

Recommendation: **B, with an explicit Poll compatibility adapter**. Introduce a
higher-level `participation_campaigns` product entity for standalone Campaigns,
keep existing Poll reward semantics and rows intact, and generalize only the
lower financial services behind a Poll/Campaign settlement context. Do not make
`poll_id` nullable in the existing table or create a polymorphic nullable mega-row.

Public Giveaway is the nearest vertical slice. None of the five Campaign types
is release-ready because claim identity, standalone eligibility, management,
closure, refunds, and Campaign proof do not exist yet.

## 1. Current V2B.2 Engine Map

### Financial schema

| Layer | Actual implementation | Readiness finding |
|---|---|---|
| Campaign offer | `reward_campaigns` in `20260822000000_v2b2_rewarded_participation.sql` | Poll-bound offer, terms, capacity, balances, lifecycle. Not standalone. |
| Vault | `reward_campaign_vaults` in `20260822120000_v2b2_reward_campaign_vaults.sql` | One isolated vault per reward campaign; encrypted key material; service-role only. |
| Funding | `reward_funding_transactions` plus `begin_reward_funding_atomic` and `bind_reward_funding_transaction_atomic` | Intent/bind boundary, unique reference/hash protection, designated funder. |
| Receipt | `reward_receipts` | Integer Luna entitlement ledger; one raw wallet value per campaign; no option field. |
| Payout attempt | `reward_payout_attempts` plus V2B.2.7 metadata | Durable signed bytes/hash, broadcast markers, retry log, partial-unique hash. |
| Refund | `reward_refunds` | Schema and uniqueness indexes exist; no close, refund, broadcast, observation, or confirmation service/RPC. |

Current indexes include campaign status/creator, funding campaign/creator and
partial hashes, receipt campaign/participant/Poll, attempt receipt and pending
hash, and refund campaign/hash. There is no Campaign claim, secret, allowlist,
event-proof, or canonical-wallet uniqueness structure.

### Funding path

`POST /api/polls/[pollId]/reward/funding/intents` derives the session wallet and
campaign from the Poll. The client sends through Nimiq Pay and posts a hash to
the bind route. The confirm route observes the stored hash through
`createNimiqTransactionObservationAdapter`, applies `reconcileRewardFunding`,
then calls `confirm_reward_funding_atomic`.

Funding confirmation checks persisted terms, vault recipient, network, memo,
execution, and amount. Underpayment is rejected. Overpayment within the single
confirmed funding transaction is recorded as `refundable_excess_luna`.

Actual limitation: after the campaign becomes funded, a second distinct funding
transaction is not modeled as additional excess; the funding RPC is state
guarded. Unsolicited vault funds are also not reconciled into creator balances.

### Poll reward path

`POST /api/polls/[pollId]/vote` authenticates through
`getVerifiedWalletSession`, calls `cast_poll_vote_atomic`, then calls
`claim_reward_receipt_atomic` and `executeReservedRewardPayout` when applicable.
The reservation RPC loads the wallet and Poll from `poll_votes`, excludes the
Poll creator, checks public/rewarded Poll state, locks the campaign, enforces
capacity, inserts the receipt, increments the count, and sets
`first_reservation_at` once.

This is intentionally automatic:

```text
verified vote -> reservation -> server payout -> reconciliation -> paid
```

It must not become the Campaign claim path.

### Payout and finality path

`src/lib/rewards/payout.ts` loads receipt-derived recipient/amount and
vault-derived sender, signs server-side through `withCampaignVaultKey`, persists
the signed transaction and hash before network contact, marks broadcast start
before the call, and broadcasts through `src/lib/nimiq/broadcast.ts`.

`src/lib/rewards/payout-reconciliation.ts` observes the stored hash through the
existing adapter, reuses `reconcileRewardPayout`, reacquires the campaign vault
lease, and calls `confirm_reward_payout_atomic`. Paid requires exact sender,
recipient, amount, hash, network, successful execution, canonical inclusion, and
macro finality. A hash-bearing uncertain attempt remains pending/manual-review-
compatible. `retry_reward_payout_atomic` permits only a hashless definite
pre-broadcast retry, bounded at five attempts.

The current finality RPC accepts server-produced evidence and validates its
shape, but does not query the chain itself. The pure policy and observer enforce
the chain proof. This trusted-server boundary must remain explicit or be
strengthened before a generic financial RPC is exposed to more callers.

### Wallet and authorization

`/api/wallet-proof/challenge` creates a five-minute server challenge containing a
random nonce, domain, wallet, issue/expiry times, and purpose. `/verify` checks
origin, challenge expiry/use, canonical address, public-key-derived address, and
signature, then atomically consumes the challenge and creates a 12-hour hashed
token session. `getVerifiedWalletSession` checks cookie hash, expiry, revocation,
and wallet address. The client tracks connected-wallet mismatch separately.

These primitives prove wallet control and session identity. They do not prove a
Campaign claim because the current challenge is not bound to a Campaign, claim
purpose, or claim nonce.

## 2. Reuse / Generalization / Specificity Matrix

| Layer | Classification | Why |
|---|---|---|
| Wallet verification | **REUSE UNCHANGED** for session authentication | Challenge, signature verification, canonical address, hashed cookie session, revocation, and wallet-switch handling are shared identity infrastructure. Campaign claims need a separate bound challenge. |
| Campaign/vault creation | **GENERALIZE** | `vault-service.ts` is reusable, but current creation is called from Poll publish/config routes and keys state to `reward_campaigns`. |
| Funding terms | **GENERALIZE** | Bigint principal, fee reserve, total budget, minimum, and exact recipient economics are shared. Funding owner/refund policy and eligibility are not. |
| Funding initiation | **GENERALIZE** | Intent, bind, deadline, hash uniqueness, and Nimiq Pay transfer are reusable; current RPC requires a public Poll and Poll campaign. |
| Chain observation | **REUSE UNCHANGED** | `observation.ts` is the sole strict RPC adapter and already exposes normalized transaction and finality evidence. |
| Canonical/finality proof | **REUSE UNCHANGED** | Main-chain block membership, batch, finalizing macro-block, and no confirmation-count shortcut are the correct shared proof. |
| Funding confirmation | **GENERALIZE** | The atomic pattern and exact amount/recipient checks are shared; Poll FK/public checks and current one-primary-funding assumption are Poll/legacy constraints. |
| Reward amount/capacity accounting | **GENERALIZE** | Principal, fee reserve, exact integer Luna, capacity, and no overspend are shared. The financial owner/source must no longer imply a Poll. |
| Eligibility | **POLL-SPECIFIC** | Current policy reads `poll_votes`, `polls`, `economic_model`, `reward_mode`, and Poll creator identity. |
| Reservation | **GENERALIZE** | Campaign lock, durable wallet uniqueness, authoritative amount loading, and atomic counter transition are shared. The reservation input must become a server-produced claim/eligibility result rather than a vote row. |
| `first_reservation_at` boundary | **GENERALIZE** | It is a useful one-time terms-freeze boundary for any reward campaign, though the current implementation is attached to Poll reward reservation. |
| Payout attempt creation | **GENERALIZE** | Attempt numbering, durable preparation, and guarded state transitions are source-independent, but current RPC joins through Poll-bound reward rows. |
| Vault signing | **REUSE UNCHANGED** at the custody boundary | `withCampaignVaultKey`, AES-GCM envelope, address self-check, transient key scope, and exact basic transfer shape are the right primitive. Rename/adapt only the record lookup. |
| Broadcast | **REUSE UNCHANGED** | Server-only `sendTransaction` adapter and pre-call markers protect the irreversible boundary. |
| Payout reconciliation | **GENERALIZE** | Exact payout policy is already Poll-independent; context loading and atomic SQL still validate `receipt.poll_id = campaign.poll_id`. |
| Retry safety | **GENERALIZE** | Hash-bearing no-resend and hashless pre-broadcast retry rules are shared; Campaign management needs a caller and explicit manual-review workflow. |
| Refunds/closure | **CAMPAIGN-SPECIFIC NEW WORK / BLOCKER** | Only tables exist. Close/refund reservation, balance reconciliation, broadcast, finality, authorization, and unresolved-obligation blocking are absent. |
| Public proof | **CAMPAIGN-SPECIFIC NEW WORK** | Current public RPC is Poll-ID based and exposes only the reward offer, not Campaign funding/payout/refund proof. |
| Creator management | **CAMPAIGN-SPECIFIC NEW WORK** | Current config is a Poll creator route; no Campaign management, retry, close, refund, or proof API exists. |
| Participant UX | **CAMPAIGN-SPECIFIC NEW WORK** | Polls have automatic rewards and no Claim button. Campaigns need an intentional claim journey and type-specific eligibility UI. |

## 3. Campaign Entity Recommendation

### Alternatives

| Option | Benefits | Actual-code cost/risk |
|---|---|---|
| A. Generalize `reward_campaigns` directly | Fewer named tables initially. | Requires nullable `poll_id`, source/type columns, altered FKs and RPCs, and mixed Poll/Campaign constraints. It would turn Poll assumptions into nullable branches and risks changing existing reward semantics. |
| B. Higher-level `participation_campaigns` with an explicit financial adapter | Separates product type/eligibility/lifecycle from settlement; preserves existing Poll rows and semantics; supports five types without Poll-shaped columns. | Requires a compatibility boundary and an additive financial binding design. Some financial rows currently carry `poll_id` and need a deliberate future relational shape. |
| C. Duplicate a complete Campaign reward stack | Fastest isolated prototype. | Duplicates money logic, custody, retry, finality, and refund behavior; creates divergent safety fixes and two ledgers. |

### Recommendation: B

Use a higher-level `participation_campaigns` entity for standalone Campaign
identity: type, owner, source/creator metadata, configured lifecycle, expiry,
and eligibility strategy configuration. Keep `reward_campaigns` as the explicit
Poll reward adapter for existing and near-term Poll compatibility.

V2C.1 should extract a code-level settlement contract rather than immediately
rewriting every table. The contract should operate on a source-independent
financial campaign context: campaign/account identity, vault, funding terms,
recipient wallet, exact Luna amount, network, attempt, and claim/receipt
identity. Poll code supplies that context from `poll_votes`; Campaign code
supplies it from a verified claim.

For standalone Campaign storage, add an additive financial binding that does not
make existing `poll_id` semantics nullable. The exact table split should be
designed in V2C.1 after the refund and fee-accounting gaps below are resolved.
Do not migrate existing Poll reward rows into the new entity merely for naming
consistency.

## 4. Shared Financial and Claim Boundaries

### Financial boundary

The reusable boundary is:

```text
server-authoritative offer
-> creator/funder intent
-> wallet transfer or server payout
-> stored hash
-> Nimiq observation
-> canonical/finality decision
-> security-definer atomic ledger transition
```

No lower layer should read `poll_votes`, `poll_options`, Campaign codes,
allowlists, QR payloads, or browser reward values. It should receive a typed,
server-built settlement context and derive economic terms from durable rows.

### Reservation boundary

The shared reservation operation should accept only a server-produced claim
candidate, conceptually:

```text
financialCampaignId
claimantWalletFromVerifiedSession
eligibilityClaimIdOrServerProof
claimNonceOrClaimIdentity
```

The reservation operation must load the reward amount, recipient, capacity,
campaign owner, and lifecycle from the database. It must lock the financial
campaign, enforce one canonical wallet per Campaign, insert the reservation
receipt, increment capacity, and set the first-reservation boundary atomically.

The browser may submit a code or opaque token as evidence to a strategy endpoint,
but may never authoritatively submit `eligible`, amount, capacity, recipient, or
creator identity. The strategy returns a server decision or opaque durable proof;
the financial RPC never trusts a browser boolean.

## 5. Eligibility Strategy Model

All strategies should implement one server-only boundary with a common result:

```text
verified session wallet + Campaign + strategy evidence
-> eligible / generic rejected / expired
-> one atomic reward reservation
```

| Type | Eligibility input | Required server behavior |
|---|---|---|
| Public Giveaway | Verified wallet and available capacity | No extra secret; capacity remains enforced by the reservation transaction. |
| Secret Drop | Verified wallet plus submitted code | Store only a salted/strong hash; compare server-side; bind to Campaign and expiry; generic invalid response; rate-limit by wallet, IP, and Campaign; consume a valid code/claim once. |
| Private Drop | Verified wallet plus allowlist membership | Canonicalize on import and lookup; service-role writes only; immutable/versioned after activation; duplicate handling and privacy-safe responses. |
| Event Drop | Verified wallet plus event code, opaque link, or server-issued event proof | QR/deep link carries an opaque Campaign-bound value; enforce expiry, scope, capacity, and replay rules; verify actual Nimiq Pay deep-link behavior on device. Do not assume a native scanner API. |
| Community Reward | Verified wallet plus contributor/community membership | Start with an internal server-authoritative allowlist/set; do not invent external contributor integrations; distinguish eligibility from the existing `funding_mode=community`. |

Existing `funding_mode=community` only selects a designated funding wallet. It
does not model community eligibility and must not be reused as the Community
Reward type.

## 6. Claim Identity, Wallet, and Replay

The existing wallet proof can be reused for wallet ownership and session auth:
`signMessage`, `normalizeAddress`, `deriveAddressFromPublicKey`,
`verifyNimiqMiniAppSignature`, single-use challenge consumption, and
`getVerifiedWalletSession` are appropriate primitives.

The existing challenge cannot be reused unchanged for a Campaign claim. Its
message has a wallet-verification purpose and no Campaign ID or claim identity.
A future Campaign claim challenge must bind:

```text
purpose = campaign_claim
campaign_id
claimant canonical wallet
random nonce (stored hashed or inside a server-bound record)
expiry
```

Nonce consumption must be atomic. Durable uniqueness remains
`UNIQUE(campaign_id, canonical_wallet)`: this proves one wallet claim, not one
human. The current receipt unique constraint is on raw text, while current
routes normally insert canonical addresses; a generalized boundary should make
canonical storage/uniqueness a database-enforced invariant, not only an API
convention.

## 7. Lifecycle Mapping

The current reward state vocabulary is:

```text
configured -> funding_pending -> funded -> rewarding -> exhausted
                                      \-> closed -> refunding -> refunded
configured/funded -> cancelled (policy-dependent)
```

Recommended Campaign mapping without inventing redundant financial states:

| Campaign concept | Existing evidence/mapping |
|---|---|
| `draft` | No current `reward_campaigns` state. Belongs to future product entity. |
| `configured` | Existing `reward_campaigns.status = configured`. |
| `funding_pending` | Existing funding intent and campaign state. |
| `funded` | Existing confirmed chain funding transition. Operationally active before the first claim. |
| `active` | `funded` or `rewarding`; do not add a duplicate state unless product semantics require it. |
| `exhausted` | Existing final-cap state. |
| `expired` | No existing state. Prefer product expiry plus an atomic close policy before adding a new persisted financial state. |
| `cancelled` | Existing state, but current cancel RPC is absent. |
| `reconciling` | No Campaign state; currently represented by payout/funding attempt states and reconciliation results. Keep financial attempt state separate. |
| `refunding` | Existing vocabulary only; no implementation. |
| `refunded` / `closed` | Existing vocabulary only; no close/refund transition implementation. |

Poll status (`draft|live|closed|cancelled`) must remain separate from Campaign
status. Campaign expiry or closure must not redefine Poll voting semantics.

## 8. Five-Type Readiness Matrix

| Type | Verdict | Reusable engine | Missing before a real flow |
|---|---|---|---|
| Public Giveaway | **Conditional / closest** | Funding, isolated vault, exact payout, finality, retry, wallet session | Standalone Campaign entity, claim/reservation path, management, close/refund, Campaign proof, physical QA. |
| Secret Drop | **Not ready** | Same financial path after eligibility | Hashed secret, generic errors, rate limiting, claim nonce/consumption, brute-force tests. |
| Private Drop | **Not ready** | Same financial path after eligibility | Allowlist storage/import, canonical uniqueness, tamper protection, privacy model, management. |
| Event Drop | **Not ready** | Same financial path after eligibility | Event proof/code, QR/deep link contract, expiry/replay handling, device validation; no scanner API assumption. |
| Community Reward | **Not ready** | Same financial path after eligibility | Contributor/community set model, versioning/import, eligibility privacy, funding-vs-eligibility distinction. |

## 9. Financial Requirements Audit

| Requirement | Current result |
|---|---|
| Isolated vault per campaign | **Yes for Poll reward campaigns.** `campaign_id` is the vault primary key; key is AES-256-GCM encrypted at rest. |
| Creator-funded principal and fee reserve | **Yes, partially.** Terms and designated funder are persisted; `community` means funder mode, not eligibility. |
| Actual on-chain funding verification | **Yes.** Stored hash is observed and finalized before funding confirmation. |
| Overpayment preserved as refundable excess | **Yes for one confirmed funding transaction.** Additional/unsolicited funds are unresolved. |
| Underpayment not active | **Yes.** Pure policy and atomic funding RPC reject it. |
| Integer Luna accounting | **Yes with a ceiling.** DB is `bigint`, but generated application types and several routes use safe JS `number`; the safe-number limit is enforced in key paths. |
| Durable receipt uniqueness | **Yes by raw `(campaign_id, participant_wallet)`, but canonical case/whitespace should become DB-enforced for general Campaigns.** |
| Atomic capacity | **Yes.** Campaign row lock, counter, receipt insert, and final-slot state change are one transaction. |
| Per-vault serialized payout | **Yes for the current campaign lease.** It serializes external signing/broadcast per campaign; it is not yet a durable queue. |
| Duplicate-send protection | **Yes for the implemented boundary.** Signed bytes/hash and broadcast-start marker persist before network contact; hash-bearing retry is blocked. |
| Finality before paid | **Yes through the server observer/pure policy.** The atomic RPC itself trusts server-produced evidence and does not query chain. |
| Safe retry boundary | **Yes.** Only definite hashless pre-broadcast failure can create a new attempt, max five. |
| Explicit unresolved/manual-review state | **Partial.** `pending` plus `error_code` is compatible with manual review, but there is no dedicated state or reconciliation worker/queue. |
| Refunds and closure | **No.** Only schema exists; no financial transition is implemented. |

Poll assumptions embedded in the engine are `poll_id` foreign keys, one campaign
per Poll, public Poll checks, `poll_votes` participation, Poll creator
exclusion, `economic_model/reward_mode`, Poll publish/config routes, and receipt
proof language that says participation in a Poll.

## 10. Refund and Closure Dependency

Refund/closure is **required before the first Campaign MVP release or physical
Campaign QA**, although its implementation can follow a non-funded internal
vertical-slice spike. It cannot safely remain after a real Campaign begins
holding creator funds.

Required work includes:

- close/expire/cancel transitions under a campaign lock;
- proof that all `reserved`, `payout_pending`, `retryable`, and other unresolved
  obligations are settled or terminally resolved before refund;
- remainder calculation from confirmed funding, paid principal, confirmed fees,
  and excess funding;
- `fee_spent_luna` advancement from confirmed payouts, which the current paid
  RPC does not perform;
- creator/funder refund policy when `funding_mode = community`;
- protection against unsolicited or unobserved vault balance being over-refunded;
- server-signed refund, durable hash binding, canonical/finality observation,
  idempotent confirmation, and final close state.

The roadmap's V2C.11 placement is acceptable only as an implementation slice if
V2C.3 is not called production-complete, funded, or physically QA-ready until
V2C.11 is done. The release gate should move this dependency ahead of any real
Campaign launch.

## 11. Security Audit

| Threat | Existing protection | Required Campaign protection |
|---|---|---|
| Duplicate claims | Receipt unique key and atomic reservation | Canonical wallet uniqueness plus one claim identity per Campaign. |
| Secret brute force | None in current Campaign code | Hash-only secret, generic response, wallet/IP/Campaign rate limits, expiry, monitoring. |
| Allowlist tampering | No allowlist exists | Service-role writes, immutable/versioned activation snapshot, canonical address constraints, audit trail. |
| QR/code sharing | No Campaign code exists | Treat codes as shareable only by policy; bind claim to wallet, Campaign, expiry, nonce, capacity, and single-use proof where required. |
| Creator self-claim | Poll reservation excludes Poll creator | Campaign claim must default to owner exclusion and use immutable owner identity. |
| Capacity races | Campaign row lock and atomic count | Reuse the same lock for every eligibility strategy. |
| Payout replay | Stored hash, broadcast marker, unique hash, guarded confirmation/retry | Preserve the same lower boundary for every Campaign type. |
| Vault concurrency | Per-campaign lease across signing/broadcast | Keep one vault per Campaign and add durable queue/recovery policy before scale. |
| Malformed eligibility proof | No Campaign proof parser | Strict typed strategy parsers, size limits, expiry, purpose and Campaign binding. |
| Claim nonce replay | Wallet verification challenge is single-use | Add a Campaign-bound single-use nonce/challenge; session alone is insufficient. |
| Client-forged reward data | Current Poll financial RPC derives amount/recipient from DB | Campaign APIs must never accept client amount, recipient, capacity, owner, or `eligible`. |
| Finality spoofing | Pure policy and server-only observer; RPC is server-role only | Keep observer-only chain proof and decide whether atomic evidence consistency needs a DB backstop. |
| Funding excess/unsolicited NIM | Single funding excess field | Reconcile all vault inflows or define a conservative refund policy before release. |

## 12. Schema and Migration Implications

No schema change belongs in V2C.0. Later design should consider:

- a `participation_campaigns` entity with type, owner/source, configured lifecycle,
  expiry, and non-financial eligibility configuration;
- an additive financial binding that can identify both Poll reward adapters and
  standalone Campaign settlement without nullable Poll-only semantics;
- Campaign-specific strategy records or versioned eligibility snapshots for
  secrets, allowlists, event proofs, and community membership;
- a durable Campaign claim/challenge record with Campaign ID, canonical wallet,
  nonce hash, purpose, expiry, consumed timestamp, and replay constraints;
- database-enforced canonical wallet normalization/uniqueness;
- refund evidence fields equivalent to payout finality evidence, close/refund
  RPCs, and an explicit fee-accounting source;
- indexes for Campaign status/type, claim `(campaign, wallet)`, secret/allowlist
  lookup, event proof expiry, unresolved obligations, and financial hashes.

Do not alter existing Poll reward rows or reinterpret legacy support rows.
`legacy_support`, Poll participation rewards, and standalone Campaign rewards
must remain distinct auditable meanings.

## 13. API, Service, and UI Implications

### API/service

- Keep `/api/polls/...` funding, voting, and automatic payout behavior Poll-scoped.
- Add a separate Campaign creation surface and Campaign-ID routes later.
- Add an eligibility strategy boundary before the shared reservation boundary.
- Add Campaign-bound claim challenge/nonce handling.
- Reuse funding, observation, signing, payout, and reconciliation adapters only
  through a source-independent settlement context.
- Add creator Campaign management, close, retry/manual-review, refund, and proof
  APIs before release.
- Add public Campaign discovery/proof reads with explicit allowlists; do not
  expose vault ciphertext, session data, selected options, or unsupported proof.

### Navigation and participant UX

Keep three separate top-level actions:

```text
Browse Polls | Create Poll | Create Campaign
```

Polls remain `participate -> automatic reward` with no Claim button. Campaigns
remain `open -> satisfy eligibility -> intentionally claim -> reserve -> payout`.
Campaign pages must be type-aware and truthful; unsupported types must not be
represented by fake cards. Event UX may use QR and deep links only after target
device behavior is proven.

## 14. NIM-Center Validation

| Type | NIM enters | Eligibility unlocks | Reservation | Payment | Proof |
|---|---|---|---|---|---|
| Public Giveaway | Creator/funder sends principal plus fee reserve to isolated vault. | Verified wallet and remaining capacity. | Atomic one-wallet claim. | Vault signs exact reward to claimant. | Stored hash is observed executed, canonical, and macro-final before `paid`. |
| Secret Drop | Same vault funding. | Verified wallet plus valid server-checked secret. | Same atomic reservation. | Same vault payout. | Same chain evidence plus claim proof metadata; chain does not prove code entry. |
| Private Drop | Same vault funding. | Verified wallet present in server allowlist. | Same atomic reservation. | Same vault payout. | Same payout proof; chain does not prove allowlist membership. |
| Event Drop | Same vault funding. | Verified wallet plus scoped event code/link/proof. | Same atomic reservation. | Same vault payout. | Same payout proof; QR/deep link is an off-chain activation mechanism. |
| Community Reward | Same vault funding, with funder policy explicitly defined. | Verified wallet in contributor/community set. | Same atomic reservation. | Same vault payout. | Same payout proof; chain does not prove contributor status. |

NIM remains product-critical in every type: the creator commits real NIM, the
Campaign capacity is bounded by funded principal, the vault performs actual NIM
settlement, and the payment is proven against the Nimiq chain. Removing NIM
would leave a generic eligibility/claim application and would remove Votum's
central verified participation-to-settlement proposition.

## 15. Blockers and Non-Blockers

### Blockers before V2C.1 / Campaign release

- V2B.2.11 refund/closure work is incomplete; `fee_spent_luna` and unsolicited/
  excess-funding policy must be resolved.
- Current Poll reward config/publish paths are not a standalone Campaign boundary;
  the recorded plan still notes creator management/config authorization issues.
- No Campaign-bound claim nonce/challenge or durable claim proof exists.
- No secret rate limiting, allowlist model, event proof model, or community
  eligibility model exists.
- No explicit Campaign creator management, manual-review queue, closure, refund,
  or public proof service exists.
- Canonical wallet uniqueness is not fully database-enforced for arbitrary direct
  service-role writes.
- The finality evidence trust boundary must be retained or hardened before
  generalizing the atomic settlement RPC.
- V2B.2.13 regression completion and V2B.2.14 physical Poll reward QA remain
  pending in the roadmap, despite the V2B.2.8 automated gates being green.

### Explicit non-blockers

- Poll and Campaign creation remain separate; this is required product behavior.
- Verified wallet is not unique human identity; one-wallet-one-claim is the
  declared boundary.
- Event Drop does not need a native scanner API if QR/deep-link behavior is
  proven through supported browser/Nimiq Pay behavior.
- Cashlinks, multisig, smart contracts, multi-token rewards, teams, recurring
  Campaigns, leaderboards, and advanced Sybil detection are out of scope.
- Existing Poll reward rows do not need migration merely because Campaigns are
  introduced.

## 16. Required V2B.2 Prerequisites

| Unfinished item | Before V2C.1? | Reason |
|---|---|---|
| V2B.2.9 Poll participant UX | Not a financial blocker; required before V2B.2 release gate | Poll-specific surface can remain separate, but must not regress when shared code is extracted. |
| V2B.2.10 Explore Earn NIM | Not a financial blocker; required before V2B.2 release gate | Poll discovery integration is not Campaign eligibility. |
| V2B.2.11 creator reward management/refunds | **Yes for a production Campaign; minimum financial closure design before V2C.1** | Campaigns cannot safely hold funds without unresolved-obligation blocking, fee accounting, refund, and closure. |
| V2B.2.12 profile NIM-earned integration | Not a V2C.1 financial blocker | It is a Poll/profile read-surface extension; paid-only semantics must remain correct. |
| V2B.2.13 full V2B.2 regression gate | **Yes before declaring shared generalization safe** | Establishes the no-regression baseline for Poll financial behavior. |
| V2B.2.14 physical Nimiq Pay QA | Before Campaign physical E2E; not required for static V2C.1 design | It validates the existing device boundary that Campaign funding and later claims depend on. |

The current automated V2B.2.8 gates are not equivalent to completing these
unfinished Poll surfaces or physical QA.

## 17. Recommended Implementation Order After V2C.0

The recorded order is retained where it is compatible with actual code, with
the closure dependency pulled forward as a release gate:

1. Finish V2B.2.11 financial closure/refund design and implementation, resolve
   fee accounting and excess/unsolicited-funding policy, and run V2B.2.13.
2. Complete V2B.2.9, V2B.2.10, V2B.2.12, and V2B.2.14 as the Poll compatibility
   and device baseline. These can be parallel to non-funded Campaign design but
   not skipped for release.
3. **V2C.1:** extract the source-independent settlement context and shared
   financial services; preserve the Poll adapter and existing Poll semantics.
4. **V2C.2:** add the separate Create Campaign entity and type selector, with no
   Poll creation merge and no unsupported fake flows.
5. **V2C.3:** build Public Giveaway as the first Campaign vertical slice through
   verified claim, atomic reservation, payout, finality, proof, and management.
6. Apply the V2C.11 closure/refund release gate before calling the Giveaway
   funded, production-ready, or physical-QA-ready.
7. **V2C.8:** complete Campaign management and unresolved/manual-review tooling
   before expanding funded Campaign types.
8. **V2C.4:** add Secret Drop strategy, hashing, generic errors, rate limits, and
   replay tests.
9. **V2C.5:** add Private Drop allowlist storage, import, privacy, and tamper
   protections.
10. **V2C.6:** add Event Drop code/link/QR/deep-link behavior and physical proof.
11. **V2C.7:** add Community Reward eligibility sets without external integrations.
12. **V2C.9:** add separate Campaign discovery without payout ranking or casino
   presentation.
13. **V2C.10:** add public Campaign proof with explicit chain/off-chain limits.
14. **V2C.12:** run the security gate across claims, allowlists, secrets, vaults,
   finality, retries, and refunds.
15. **V2C.13:** run physical Nimiq Pay E2E for all five real Campaign types.

The practical change from the roadmap is not to merge the types or Polls; it is
to prevent a funded Campaign release from preceding closure/refund safety and
creator operational controls.

## 18. Final Audit Findings

1. Recommended architecture: higher-level `participation_campaigns` plus an
   explicit Poll compatibility adapter over generalized settlement services.
2. It beats direct table polymorphism by preserving Poll semantics and avoiding
   Poll-only nullable columns; it beats duplication by retaining one money engine.
3. Reuse unchanged: wallet session primitives, Nimiq observation/finality,
   server vault custody boundary, signing, broadcast, and core payout safety.
4. Generalize: funding context, financial terms, reservation input, lifecycle
   freeze, payout context, reconciliation context, and retry services.
5. Keep Poll-specific: `polls`, `poll_votes`, options, vote uniqueness, economic
   model/reward mode, automatic payout-after-vote, Poll creator exclusion, and
   Poll discovery/creation.
6. New Campaign primitives: Campaign entity/type, eligibility strategies,
   claim challenge/nonce, claim proof/consumption, allowlists/secrets/event
   proofs, management, closure, refunds, and Campaign proof.
7. Shared reservation boundary: server-produced eligibility claim plus verified
   canonical wallet; amount, recipient, owner, capacity, and terms loaded server-side.
8. Readiness: Public Giveaway conditional/closest; Secret, Private, Event, and
   Community not ready.
9. Refund verdict: required before any real funded Campaign MVP release; may be a
   preceding internal implementation slice but not deferred past release.
10. Security blockers: claim replay/nonce, secret brute force, allowlist tamper,
    missing closure/refund lock, unresolved manual review, canonical uniqueness,
    and excess/unsolicited-funding policy.
11. Expected schema work: Campaign entity, financial binding, strategy records,
    claim challenge/claims, canonical uniqueness, refund evidence, and indexes.
12. V2B.2 prerequisites: closure/refund and fee accounting plus regression gate
    before shared financial generalization; remaining Poll UX/profile/device work
    before full product release and Campaign physical E2E.
13. Recommended sequence: V2B financial closure/regression, Poll compatibility,
    V2C.1, V2C.2, Public Giveaway, closure gate, management, remaining types,
    discovery, proof, security, physical E2E.
14. NIM verdict: all five types remain NIM-centered through prepaid funding,
    bounded reservation, vault payout, and observed on-chain proof.

## Evidence Index

- `supabase/migrations/20260822000000_v2b2_rewarded_participation.sql`
- `supabase/migrations/20260822120000_v2b2_reward_campaign_vaults.sql`
- `supabase/migrations/20260822130000_v2b2_campaign_funding_initiation.sql`
- `supabase/migrations/20260822130100_v2b2_funding_hash_guard.sql`
- `supabase/migrations/20260906000000_v2b2_confirm_reward_funding.sql`
- `supabase/migrations/20260906010000_v2b2_reserve_participant_reward.sql`
- `supabase/migrations/20260912010000_v2b2_broadcast_reserved_reward_payouts.sql`
- `supabase/migrations/20260912020000_v2b2_reconcile_reward_payouts.sql`
- `supabase/migrations/20260912030000_v2b2_safe_reward_payout_retry.sql`
- `src/lib/rewards/eligibility.ts`
- `src/lib/rewards/config.ts`
- `src/lib/rewards/funding-confirmation.ts`
- `src/lib/rewards/payout.ts`
- `src/lib/rewards/payout-reconciliation.ts`
- `src/lib/rewards/vault-key.ts`
- `src/lib/rewards/vault-service.ts`
- `src/lib/rewards/vault-signing.ts`
- `src/lib/nimiq/observation.ts`
- `src/lib/nimiq/client.ts`
- `src/lib/api/session.ts`
- `src/app/api/polls/[pollId]/vote/route.ts`
- `src/app/api/polls/[pollId]/reward/config/route.ts`
- `src/app/api/polls/[pollId]/reward/funding/intents/route.ts`
- `src/app/api/polls/[pollId]/reward/funding/intents/[intentId]/bind/route.ts`
- `src/app/api/polls/[pollId]/reward/funding/intents/[intentId]/confirm/route.ts`
- `src/app/api/polls/[pollId]/reward/payouts/[attemptId]/reconcile/route.ts`
- `src/app/api/wallet-proof/challenge/route.ts`
- `src/app/api/wallet-proof/verify/route.ts`
- `src/providers/VotumSessionProvider.tsx`
- `docs/superpowers/specs/2026-08-22-v2b2-rewarded-participation-design.md`
- `docs/superpowers/plans/2026-08-22-v2b2-rewarded-participation-implementation.md`
