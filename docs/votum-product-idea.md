# Votum — Product Idea

**Product name:** Votum  
**Pronunciation:** `VOH-tum`  
**Name origin:** Latin *votum* — a vow, wish, or vote  
**Category:** NIM-backed community decision Mini App  
**Platform:** Nimiq Pay Mini Apps Framework  
**Core asset:** NIM

## 1. Product summary

**Votum turns free clicks into accountable community signal.**

Creators, builders, and communities create a question, define options, set a small NIM contribution threshold, and share the poll. Voters choose an option and make a lightweight NIM payment through Nimiq Pay. Votum records a verified vote only after the payment is confirmed, then shows both wallet participation and NIM-backed conviction.

> **Put NIM behind your say.**

Votum is not betting, a prediction market, or a winner-takes-pot game. It is a transparent contribution-backed decision tool.

## 2. Why the name changed

The original name explains the mechanic but is generic, transactional, and pulls the product toward paid surveys or gambling.

**Votum** is stronger because it names the act of meaningful support rather than the payment. It gives the system useful language:

- Votum Poll
- Votum Signal
- Votum Receipt
- Votum Result
- Votum Creator
- Votum Support

Trademark, domain, social-handle, and legal availability have **not** been checked.

## 3. Problem

Free online polls have weak signal. They are easy to ignore, spam, brigade, or treat as entertainment. A click does not show whether the voter will support the resulting decision.

Creators and communities need a clearer answer:

> What does our community care about enough to support with a small amount of value?

## 4. Product thesis

A tiny, explicit NIM contribution makes community feedback more deliberate without turning it into gambling.

The product adds **commitment**, not speculation:

- a voter supports a stated decision;
- the contribution destination is shown before payment;
- the result shows wallet count and NIM signal separately;
- the creator cannot claim that the NIM automatically funds a specific option unless that payment mechanism truly exists.

## 5. Priority user

### Launch audience

> Nimiq builders and creators who need their small communities to choose a next feature, content direction, or community priority.

This is the best contest wedge because it is easy to dogfood in the Nimiq community and naturally generates shareable polls.

### Secondary audiences

| Audience | Job |
|---|---|
| Indie hackers | Decide feature priorities with stronger signal than comments |
| Creators | Ask audiences what to make while receiving transparent support |
| Community organisers | Collect support-backed feedback for a visible community wallet |
| Event organisers | Choose an event topic, date, or resource direction |
| Product teams | Test names or roadmap options with real participation |

## 6. The MVP: Votum Signal Poll

### Creator flow

1. Open Votum inside Nimiq Pay.
2. Choose a template or enter a question.
3. Add 2–6 options.
4. Set poll duration and minimum NIM contribution.
5. Select one transparent contribution destination.
6. Publish and share the poll link or QR code.

### Voter flow

1. Open the poll in Nimiq Pay.
2. Read what the contribution supports and where the NIM goes.
3. Choose one option.
4. Confirm NIM payment.
5. Receive a Votum Receipt.
6. See live results after transaction verification.

### Required result information

- leading option;
- wallet count by option;
- NIM signalled by option;
- total NIM contributed;
- poll deadline / closed state;
- selected fairness mode;
- verified transaction proof link or reference;
- clear contribution destination.

## 7. Clean MVP modes

### Creator Support Poll — build now

Voters choose an option; NIM goes directly to the disclosed creator/project wallet. The vote expresses what the community wants, while the contribution supports the creator’s work generally.

### Community Support Poll — build now

NIM goes directly to a disclosed community/project wallet. The poll recommends a priority; the wallet destination is clear before payment.

### Fund the Winner — message carefully

Only say that NIM “funds the winning decision” if the user can see a credible, explicit mechanism for that outcome. With direct payments to a creator wallet and no escrow, the honest MVP message is:

> “Your NIM supports the creator implementing the community’s chosen direction.”

### Do not build for Cycle 1

- winner-takes-loser-pool;
- prediction/betting mechanics;
- payout redistribution;
- custody or escrow;
- refunds that require an unbuilt automated return flow;
- private or anonymous voting;
- full DAO governance;
- multiple-token support.

## 8. Fairness rules

Default mode:

> **One wallet, one vote. NIM is visible as a separate support signal.**

This prevents the UI from implying that the largest wallet has automatically won. Later, a creator may use capped or quadratic weighting—but not before the default experience is reliable and comprehensible.

## 9. Nimiq fit

Votum is native to Nimiq Pay because the core action is a small, immediate NIM payment. The framework removes wallet setup friction, while NIM makes a tiny contribution practical and visible.

NIM is not a cosmetic payment option. It is the product’s proof of deliberate participation.

## 10. Product language

Use:

- signal;
- support;
- contribution;
- community decision;
- NIM-backed vote;
- verified vote;
- result;
- receipt.

Avoid:

- bet;
- wager;
- odds;
- jackpot;
- pot;
- payout to winners;
- prediction;
- investment;
- profit.

## 11. Demo moment

1. A builder creates: **“Which Votum feature should we ship next?”**
2. They set a 1 NIM minimum and a clearly displayed creator wallet.
3. A voter chooses an option and confirms the NIM payment inside Nimiq Pay.
4. Votum verifies the payment and updates live results.
5. The screen shows:

> **Result Cards leads**  
> `51 wallets · 284 NIM signalled · 43% of voters`

6. The voter receives a clean, shareable receipt.

## 12. Final positioning

> **Votum is a Nimiq Pay Mini App for community decisions backed by NIM. It helps creators and builders see not only what people clicked, but what they cared enough to support.**
