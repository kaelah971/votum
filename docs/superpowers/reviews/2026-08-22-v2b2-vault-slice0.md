# V2B.2 Slice-0 — Isolated Vault Custody + Offline Signing Spike

**Date:** 2026-08-22
**Branch:** `feat/v2-participation-record`
**Starting HEAD:** `44339c34043859fe5de9a42c1e08c815f46cd1e0`
**Status:** Spike complete — **GO** for V2B.2.2B (with documented caveats).
**Scope:** Technical viability of the V2B.2 per-campaign isolated reward vault,
server-side only. **No broadcast, no real NIM, no persistence, no schema change.**

---

## 1. Installed Nimiq capability findings

| Item | Finding |
|------|---------|
| `@nimiq/core` | **2.7.2** (Node build `./nodejs/index.js`; `main`). Exports `KeyPair`, `PrivateKey`, `PublicKey`, `Address`, `Transaction`, `TransactionBuilder`, `Policy`, `Signature`, `Client`. |
| `@nimiq/mini-app-sdk` | 0.1.0 (client-side wallet provider only; not used server-side in this spike). |
| Server RPC adapter | `src/lib/nimiq/rpc.ts` — today only `getTransactionByHash` (JSON-RPC 2.0 POST to `NIMIQ_RPC_URL`, network check `NIMIQ_NETWORK_ID`, 10s timeout). No broadcast method. |
| Support transaction impl | `PollNimSupportPanel` sends via the mini-app SDK `sendBasicTransactionWithData` (client wallet), confirmed via the server RPC `getTransactionByHash`. Server never constructs/signs transactions today. |
| Broadcast RPC | `@nimiq/core` `Client.sendTransaction(transaction)` exists but requires a full network `Client` (consensus + peers) — **not currently wired anywhere in Votum**. |

### Part A–G summary (key, address, serialization, construction, signing, broadcast)

- **A. Server-side key generation:** `KeyPair.generate()` — secure randomness. Proven.
- **B. Address derivation:** `keypair.toAddress()` → `toHex()` (canonical, Votum's stored form) and `toUserFriendlyAddress()` (NQ display). Proven.
- **C. Private-key serialization:** `keypair.privateKey.serialize()` → 32 bytes; reconstruct with `PrivateKey.deserialize(bytes)` → `KeyPair.derive(priv)`. Round-trip proven (address A === address B).
- **D. Basic NIM transfer construction:** `TransactionBuilder.newBasic(sender, recipient, value, fee, validityStartHeight, networkId)` returns an unsigned `Transaction`. Proven.
- **E. Signing:** `tx.sign(keypair, undefined)` sets the signature proof in place. Proven.
- **F. Signed-tx serialization:** `tx.serialize()` (bytes) / `tx.toHex()`; hash via `tx.hash()` (64-hex). Proven; deserialize round-trip reproduces the same hash.
- **G. Future broadcast:** classified **"supported by installed package but adapter missing"** — `@nimiq/core` `Client.sendTransaction` exists (full light-client), and the Nimiq node JSON-RPC likely also offers a broadcast method, but the repo's `rpc.ts` adapter has none. Full design in Part K.

---

## 2. Key-generation primitive (exact)

`@nimiq/core` `KeyPair.generate()` — WASM-backed secure random. Serialization
strategy: encrypt **only the 32-byte private key** (`keypair.privateKey.serialize()`);
the public key and address are re-derivable via `KeyPair.derive(privateKey)`,
so only the minimum required private material is ever encrypted/persisted.

## 3. Public-address representation

- Canonical hex: `keypair.toAddress().toHex()` (40 hex chars) — Votum's stored wallet form.
- User-friendly: `keypair.toAddress().toUserFriendlyAddress()` — `NQ…` display form.

## 4. Encryption algorithm / envelope

- **AES-256-GCM** (Node `crypto`), 256-bit master key, random 12-byte IV per encryption.
- Envelope (typed, versioned):
  ```
  { version: "votum:reward-vault:v1", algorithm: "aes-256-gcm",
    iv: base64, ciphertext: base64, authTag: base64 }
  ```
- No plaintext key, no master key, no seed, no signing object inside the envelope.

## 5. Master-key contract

- Runtime env var `REWARD_VAULT_MASTER_KEY`; **32 random bytes, base64**.
- Validation rejects: missing/empty, malformed base64, wrong decoded length,
  and obviously human-readable weak strings. Tests use ephemeral in-memory keys.
- Never logged, never in any committed env file, never requested from the user.

## 6. AAD binding

`buildVaultAad({ campaignId, vaultAddressHex })` = deterministic UTF-8 string
`votum:reward-vault:v1 \0 campaignId \0 vaultAddressHex`. Proven: ciphertext
copied from campaign A into campaign B, or with the wrong vault address,
**fails authenticated decryption**.

## 7. Round-trip result

`generate → derive address A → serialize 32-byte private key → encrypt → discard
original → decrypt → reconstruct → derive address B` ⇒ **A === B** (proven).
Two independently generated campaigns produce different addresses and different
ciphertext (fresh IV per encryption).

## 8. Tamper results

All fail closed (no corrupt plaintext ever returned):
wrong key · modified ciphertext · modified auth tag · modified IV · unknown
envelope version · malformed envelope · truncated envelope · wrong AAD
(campaign or address). Each throws a class-level error, never secrets.

## 9. Transaction construction primitive

`TransactionBuilder.newBasic(sender, recipient, value, fee, validityStartHeight, networkId)`.

Proven fields:
- `sender` = campaign vault
- `recipient` = participant wallet
- `value` = exact advertised reward in Luna (no fee subtraction)
- `fee` = separate field (Nimiq semantics: sender pays value + fee; recipient gets exactly value)
- `networkId` = 42 (repo alphanet config)
- `validityStartHeight` explicit; validity window is `Policy.TRANSACTION_VALIDITY_WINDOW = 120` blocks (≈2h).

## 10. Offline signing result

`tx.sign(keypair, undefined)` succeeds; serialized signed tx is non-empty and
larger than unsigned; sender still equals vault; participant value remains exact;
fee remains separate. `tx.hash()` deterministic across serialize/deserialize.

## 11. Participant exact-value result

`value` stays exactly `rewardPerParticipantLuna` (e.g. 50,000 Luna for 0.5 NIM)
before and after signing; the fee (e.g. 4,000 Luna) is a separate field and is
never subtracted from the recipient's value.

## 12. Actual Nimiq fee semantics

- Fee is a **separate bigint field** on the transaction (`tx.fee`), in Luna.
- Basic transfer: sender account is debited `value + fee`; recipient receives exactly `value`.
- Fee range is u64; construction accepts 0, 1, 4,000, 10,000 Luna without error.
- `tx.feePerByte` is derived (`fee / serializedSize`) — 4,000 Luna on a 68-byte basic tx ≈ 58.8 Luna/byte.
- `tx.verify()` against a real network requires a genesis/network context that the
  WASM build does not hold for network id 42 (alphanet) — it fails with
  "foreign network"/"invalid serialization". `isValidAt(height)` works offline.
  Full network-level acceptance must be confirmed against the actual target node
  (V2B.2.7).

## 13. Status of provisional 4000-Luna fee

**TECHNICALLY VALID provisional MVP estimate.** Construction and offline
validation accept 4,000 Luna as a basic-transfer fee, and it is comfortably
above dust. It is **not** claimed to be economically optimal — final sizing
remains a V2B.2.3 decision (as designed). No change required by this spike.

## 14. Future broadcast mechanism (Part K)

- `@nimiq/core` provides `Client.sendTransaction(transaction)` returning
  `PlainTransactionDetails` — a full light-client with consensus/peers.
- The repo's existing `rpc.ts` adapter has **no broadcast method**.
- Classified: **supported by installed package but adapter missing**; a Nimiq
  node JSON-RPC broadcast method may also exist (probe in V2B.2.7).
- Minimal adapter for the later checkpoint:
  - Method: `sendTransaction(serializedTxHex)` → JSON-RPC `sendTransaction` (or `Client.sendTransaction`).
  - Input: serialized signed transaction bytes/hex.
  - Response: `{ hash, ... }` / `PlainTransactionDetails`.
  - Hash derivation: the transaction hash is already derivable locally
    (`tx.hash()`), so the DB can record it before broadcast (idempotency key);
    broadcast-then-response-death is recovered by re-observing the recorded hash
    via the existing `getTransactionByHash` (matches the plan's chain-truth
    reconciliation).

## 15. Key/browser-boundary result (Part L)

- `vault-key.ts` and `vault-signing.ts` both `import "server-only"` (Next build-time boundary, same as `server-crypto.ts`).
- No `"use client"` in either module.
- No `NEXT_PUBLIC_` reference to the master key anywhere in vault code.
- Static test asserts no current Client Component (src/components, src/app, src/providers, src/hooks) imports the vault modules.
- Built bundles verified: `REWARD_VAULT_MASTER_KEY` / envelope markers absent from all `.next` JS.

## 16. Secret-leak audit (Part M)

- No console/log output of master key, private key, serialized private material,
  decrypted envelope, or full signed raw tx.
- Tests use distinctive secret markers and assert they are absent from returned
  shapes and error messages.
- Errors identify the failure class (e.g. "vault envelope authentication failed",
  "unknown vault envelope version"), never the secret material.

## 17. Test totals

- `vault-key.test.ts`: 22 tests — keygen, master-key contract, round-trip, AAD
  binding, cross-campaign swap, all tamper/failure modes, envelope format.
- `vault-signing.test.ts`: 12 tests — construction, exact value, separate fee,
  network id/validity, offline signing, serialization, key/sender mismatch.
- `vault-boundary.test.ts`: 5 tests — server-only boundary, no client imports,
  no NEXT_PUBLIC key ref, zero-leak surfaces.
- Total: **39 focused spike tests, all pass.**

## 18. Regression results

- V2B.2.1 `domain.test.ts`: 22/22 pass.
- V2B.2.1 `v2b2-schema-test.ts`: 59/59 pass.
- Full vitest suite: 16 files / 116 tests pass.
- `npx tsc --noEmit`: 0 errors. `npm run lint`: 0 errors / 0 warnings.
- `npm run build`: PASS. `git diff --check`: clean.

## 19. Unresolved assumptions / risks

1. **Network-level fee/tx acceptance unverified** — `verify()` needs a live
   node/genesis for network 42. V2B.2.7 must confirm against the target node.
2. **Broadcast adapter absent** — `Client.sendTransaction` (full client) vs
   node JSON-RPC `sendTransaction` must be chosen and wired in V2B.2.7.
3. **WASM keypair lifetime** — `KeyPair` objects hold WASM memory; `.free()` is
   invoked, but long-lived server processes must confirm no leak under load.
4. **Master-key provisioning** — `REWARD_VAULT_MASTER_KEY` must be provisioned
   in the server environment before any V2B.2.2B persistence; a missing key
   fails closed.
5. **Custody risk is real and disclosed** — Votum holds per-campaign keys;
   this is custodial reward infrastructure (never marketed as non-custodial).

## 21. Custody operations note (V2B.2.2B)

V2B.2.2B persisted encrypted campaign vaults. Operational custody facts:

- **Master key required for all campaign-vault decryption.** Every persisted
  vault is AES-256-GCM encrypted under `REWARD_VAULT_MASTER_KEY` (32 random
  bytes, base64). Vault retrieval/decryption fails closed when the key is
  missing or invalid.
- **Losing the master key makes persisted campaign vault keys unrecoverable.**
  There is no plaintext fallback, no key-escrow, and no recovery path in MVP.
  Losing `REWARD_VAULT_MASTER_KEY` permanently locks the affected campaign
  vaults (and their funds, once funded).
- **Master-key rotation is NOT implemented in MVP.** Rotating requires
  re-encrypting every persisted vault envelope; no such operation exists yet.
- **Production master key must live in a real secret-manager / environment
  boundary** (e.g. an HSM-backed secret, cloud KMS, or a locked secrets store) —
  never a committed file, never a client value.
- **Backup / rotation / HSM migration is post-MVP work.**
- **Campaign-vault custody is explicitly Votum-controlled.** This is custodial
  reward infrastructure; it must never be described or marketed as
  non-custodial. Blast radius is per-campaign (one keypair per campaign).

## 20. Recommendation

**GO — V2B.2.2B (conditional).**

The isolated per-campaign vault architecture is technically viable with the
installed libraries. Key generation, address derivation, encrypted-at-rest
custody, AAD campaign binding, offline transaction construction and signing,
exact participant reward value, and separate fee semantics are all proven.
Condition: V2B.2.7 must resolve the live broadcast adapter and confirm
network-level acceptance of the provisional fee; master-key provisioning must
be in place before persisting any vault material.
