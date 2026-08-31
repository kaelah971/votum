# Votum — Product Idea

**Product name:** Votum  
**Pronunciation:** `VOH-tum`  
**Name origin:** Latin *votum* — a vow, wish, or vote  
**Category:** Verified community decision and participation-reward Mini App
**Platform:** Nimiq Pay Mini Apps Framework  
**Core asset:** Verified wallet participation, with NIM for optional funded rewards

## 1. Product summary

**Votum turns unverified clicks into accountable community decisions.**

Creators, builders, and communities create a question, define options, and share a poll. Voters verify a wallet, choose an option, and receive one vote. Creators may optionally fund a fixed NIM reward for eligible participants; reward eligibility never depends on the selected option.

> **Verified decisions. Rewards when participation is funded.**

Votum is not betting, a prediction market, or a winner-takes-pot game. It is a transparent verified-decision tool with optional participation rewards.

## 2. Why the name changed

The original name explains the mechanic but is generic, transactional, and pulls the product toward paid surveys or gambling.

**Votum** is stronger because it names the act of making a meaningful decision rather than the payment. It gives the system useful language:

- Votum Poll
- Votum Signal
- Votum Receipt
- Votum Result
- Votum Creator
- Votum Reward

Trademark, domain, social-handle, and legal availability have **not** been checked.

## 3. Problem

Free online polls have weak signal. They are easy to ignore, spam, brigade, or treat as entertainment. A click does not show whether the voter will support the resulting decision.

Creators and communities need a clearer answer:

> What does our verified community choose, and is a participation reward funded?

## 4. Product thesis

A verified wallet and one-wallet-one-vote rule make community feedback more accountable without turning it into gambling.

The product adds **commitment**, not speculation:

- a voter verifies a wallet and casts one vote;
- a creator may define a fixed reward budget;
- reward eligibility is independent of the selected option;
- funding status is shown truthfully and never presented as participant support.

## 5. Priority user

### Launch audience

> Nimiq builders and creators who need their small communities to choose a next feature, content direction, or community priority.

This is the best contest wedge because it is easy to dogfood in the Nimiq community and naturally generates shareable polls.

### Secondary audiences

| Audience | Job |
|---|---|
| Indie hackers | Decide feature priorities with stronger signal than comments |
| Creators | Ask audiences what to make while offering a transparent reward |
| Community organisers | Collect verified feedback with clear campaign funding |
| Event organisers | Choose an event topic, date, or resource direction |
| Product teams | Test names or roadmap options with real participation |

## 6. The MVP: Votum Signal Poll

### Creator flow

1. Open Votum inside Nimiq Pay.
2. Choose a template or enter a question.
3. Add 2–6 options.
4. Choose free verified participation or define a fixed reward budget.
5. Set poll duration and review the one-wallet-one-vote rule.
6. Publish and share the poll link or QR code.

### Voter flow

1. Open the poll in Nimiq Pay.
2. Read the participation and reward terms.
3. Verify a wallet and choose one option.
4. Receive a Votum Receipt.
5. See live results after vote verification.

### Required result information

- leading option;
- wallet count by option;
- reward status and reward per eligible participant when funded;
- poll deadline / closed state;
- selected fairness mode;
- verified transaction proof link or reference;
- one-wallet-one-vote rule.

## 7. Clean MVP modes

### Free Verified Poll — build now

Voters verify a wallet and choose an option. No participant payment is required, and every verified wallet receives exactly one vote.

### Rewarded Participation Poll — build now

The creator or a designated community wallet funds a fixed reward budget. Eligible participants receive the same advertised reward regardless of which option they choose.

### Legacy Support Poll — compatibility path

Historical polls may retain direct participant support. This path is explicitly labelled legacy and never defines the normal new-poll flow.

> “Legacy support is counted separately from verified votes.”

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

> **One wallet, one vote. Rewards never depend on the selected option.**

This prevents the UI from implying that the largest wallet has automatically won. Later, a creator may use capped or quadratic weighting—but not before the default experience is reliable and comprehensible.

## 9. Nimiq fit

Votum is native to Nimiq Pay because wallet verification and optional reward funding can happen in the same trusted environment. NIM makes fixed participation rewards practical and visible.

NIM is not a participant voting requirement. It is the funding rail for optional participation rewards.

## 10. Product language

Use:

- signal;
- community decision;
- verified vote;
- funded reward;
- result;
- receipt.

Use **support** and **contribution** only when describing an explicitly labelled legacy support poll.

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
2. They choose a free verified poll or define a fixed reward budget.
3. A voter verifies a wallet and chooses an option inside Nimiq Pay.
4. Votum verifies the vote and updates live results.
5. The screen shows:

> **Result Cards leads**  
> `51 verified wallets · Reward available when funded`

6. The voter receives a clean, shareable receipt.

## 12. Final positioning

> **Votum is a Nimiq Pay Mini App for verified community decisions. It helps creators and builders see what their community chose, with optional fixed rewards for eligible participation.**
