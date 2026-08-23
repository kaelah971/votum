# V2B.2.4 — Minimal Reward Campaign Funding QA

> **Status: PREPARED — PHYSICAL TEST NOT STARTED**
>
> No Nimiq Pay request has been opened and no NIM has been sent. Do not mark
> physical observations PASS until they are observed on the device.

## Preparation

| Field | Value |
|---|---|
| Branch | `feat/v2-participation-record` |
| Expected/current application HEAD | `32b0a8e` |
| Local Supabase hostname | `127.0.0.1` |
| Wi-Fi IPv4 | `192.168.0.3` |
| LAN URL | `http://192.168.0.3:3000` |
| Effective Nimiq network | Mainnet, network ID `24` |
| QA campaign | Not created automatically; physical creator ownership was not established safely |
| Physical creator session | Not impersonated or fabricated |

The local environment has an active session row, but its wallet was not
identified as the physical creator wallet. A fresh QA campaign must therefore
be created manually through the verified physical wallet session.

## Code-Derived Economics

These values were computed from `src/lib/rewards/constants.ts`, not copied from
the QA request:

| Field | Value |
|---|---:|
| Reward per participant | `1,000 Luna` / `0.01 NIM` |
| Maximum participants | `1` |
| Principal | `1,000 Luna` / `0.01 NIM` |
| Fee formula | `4,000 × 1 × 2` |
| Fee reserve | `8,000 Luna` / `0.08 NIM` |
| Required funding | `9,000 Luna` / `0.09 NIM` |

## Manual Preparation Steps

1. Open `http://192.168.0.3:3000` inside Nimiq Pay.
2. Connect and verify the physical creator wallet. Do not use a seeded or test wallet.
3. Open `/create`.
4. Create a harmless public poll with question `V2B.2.4 physical funding QA — 0.01 NIM` and options `Yes` and `No`.
5. Enable participant rewards.
6. Set reward per participant to `0.01 NIM`.
7. Set maximum rewarded participants to `1`.
8. Confirm the review shows `0.01 NIM` principal, `0.08 NIM` fee reserve, and `0.09 NIM` total.
9. Publish/configure the poll, then open its creator page at `/my-polls/[pollId]`.
10. Confirm the displayed vault and funding amounts match the server read model.
11. Stop and obtain explicit approval before tapping `Fund reward campaign`.

## Physical Checklist

| # | Check | Result | Notes |
|---:|---|---|---|
| A | Creator wallet/session verified | NOT RUN | |
| B | QA campaign shows `0.01 NIM` reward | NOT RUN | |
| C | Maximum participants is `1` | NOT RUN | |
| D | Principal is `0.01 NIM` | NOT RUN | |
| E | Fee reserve is `0.08 NIM` | NOT RUN | |
| F | Total required funding is `0.09 NIM` | NOT RUN | |
| G | Displayed vault matches server | NOT RUN | |
| H | Creator taps `Fund reward campaign` | NOT RUN | Do not perform without explicit approval |
| I | Nimiq Pay shows exact recipient | NOT RUN | |
| J | Nimiq Pay shows exact `0.09 NIM` value | NOT RUN | Wallet network fee may be additional |
| K | Creator rejects once and recovers safely | NOT RUN | No transaction should be sent |
| L | Creator retries | NOT RUN | |
| M | Creator approves the real transaction | NOT RUN | Do not perform without explicit approval |
| N | Transaction hash binds successfully | NOT RUN | Binding is not confirmation |
| O | UI shows submitted / waiting for confirmation | NOT RUN | |
| P | Campaign is still not funded | NOT RUN | |
| Q | `funded_amount_luna` remains `0` | NOT RUN | |
| R | `funded_at` remains `NULL` | NOT RUN | |
| S | No receipt, payout, or refund exists | NOT RUN | |

Everything after S belongs to V2B.2.5 and is intentionally out of scope.

## Safety Boundary

- No Nimiq Pay call was made during preparation.
- No funding intent was created automatically.
- No transaction hash was fabricated or bound.
- No campaign was marked funded.
- No chain observation or confirmation was started.
- No receipt, payout, or refund operation was started.
