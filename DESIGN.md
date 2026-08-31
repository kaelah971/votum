---
version: alpha
name: Votum
description: "The Proof Ballot — a calm, premium Nimiq Pay Mini App where community choices become verified decisions with optional funded participation rewards."
colors:
  primary: "#18201D"
  background: "#EDEDED"
  surface: "#FFFFFF"
  ink: "#18201D"
  secondary: "#68716B"
  tertiary: "#A8A8A8"
  signal-gold: "#D5A52A"
  signal-gold-hover: "#B98C1E"
  nim-blue: "#4F73A8"
  verified-green: "#3D7659"
  fairness-amber: "#B77822"
  reject-red: "#B84B44"
  border: "#DEDEDE"
  divider: "#E3E3E3"
typography:
  display:
    fontFamily: "Neue Montreal, General Sans, Inter, Arial, sans-serif"
    fontSize: 4rem
    fontWeight: 500
    lineHeight: 1.05
    letterSpacing: "-0.01em"
  heading:
    fontFamily: "Neue Montreal, General Sans, Inter, Arial, sans-serif"
    fontSize: 2.25rem
    fontWeight: 550
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  body-md:
    fontFamily: "Inter, Arial, sans-serif"
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  micro:
    fontFamily: "Inter, Arial, sans-serif"
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.03em"
  proof:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: 0.8125rem
    fontWeight: 500
    lineHeight: 1.45
rounded:
  card: 24px
  overlay: 20px
  control: 999px
  thumbnail: 16px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 48px
  2xl: 80px
components:
  button-primary:
    backgroundColor: "{colors.signal-gold}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: 16px
  button-primary-hover:
    backgroundColor: "{colors.signal-gold-hover}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: 16px
  button-secondary:
    backgroundColor: "{colors.background}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: 16px
  card-standard:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: 24px
  button-verified:
    backgroundColor: "{colors.verified-green}"
    textColor: "#FFFFFF"
    rounded: "{rounded.control}"
    padding: 12px
---

## Overview

Votum is a Nimiq Pay Mini App for verified community decisions. New polls are free to vote in, with an optional fixed reward campaign for eligible participants. Historical participant-support polls remain visibly scoped to the legacy path.

The supplied reference contributes the **interface discipline** to retain: Soft Fog background, restrained neutral field, light premium surfaces, Neue Montreal / General Sans headline direction, Inter functional type, soft-radius components, pill actions, high-fidelity 3D visual language, and a calm two-column hierarchy. Do not copy its EV-charger/greenhouse narrative.

Votum’s own visual territory is **The Proof Ballot**:

> **Question → Choice → Verified Vote → Community Result**

The app should feel composed and decisive, not playful, casino-like, DAO-generic, or dark-speculative.

## Colors

Keep the reference background exactly: **Soft Fog `#EDEDED`**. It provides the quiet premium field requested. Use the existing state colors for reward status, verification, and the explicitly scoped legacy support path.

| Token | HEX | Role |
|---|---:|---|
| Soft Fog | `#EDEDED` | Global page background; never gradient |
| Clear Ballot | `#FFFFFF` | Cards, poll surfaces and floating overlays |
| Ballot Ink | `#18201D` | Text, icon strokes, dark nav pill and high-focus content |
| Quiet Ink | `#68716B` | Secondary content and metadata |
| Micro Grey | `#A8A8A8` | Tiny utility labels only |
| Signal Gold | `#D5A52A` | The one primary action signal: create, confirm, selected vote |
| Deep Gold | `#B98C1E` | Hover/pressed Gold state |
| NIM Blue | `#4F73A8` | Payment, proof and transaction-reference context |
| Verified Green | `#3D7659` | Confirmed vote and successful outcome only |
| Fairness Amber | `#B77822` | Deadline, weighting or assumption requiring review |
| Reject Red | `#B84B44` | Failed/cancelled payment or unavailable action |

### Colour rules

- Signal Gold replaces the reference lime as the **single high-emphasis CTA colour**. It appears on the Votum mark, primary CTA and selected-choice state—nowhere else as a large block.
- NIM Blue is informational, not a primary CTA. It signals proof context and legacy payment context.
- Green means an action is verified. Amber means review; red means failure. Each must be paired with text and icon.
- No full-page gradient, neon, glow, casino green, odds colours, token-logo wallpaper, or multicolour poll options.
- Soft Fog, Clear Ballot and Ballot Ink should occupy the overwhelming majority of every view.

## Typography

Retain the reference type direction and overall restraint.

| Role | Typeface | Use |
|---|---|---|
| Headline | **Neue Montreal** or **General Sans** | Question, result, feature section and hero headline |
| UI and body | **Inter** | Controls, option labels, explanations and navigation |
| Proof data | **IBM Plex Mono** | NIM amount, shortened wallet, transaction proof, timestamp and deadline |

- Headline: 56–64px desktop / 36–44px mobile, weight 400–500, `1.05` line height. Never compensate with boldness.
- Product title: 28–36px, 500–600.
- Body: Inter 14–16px, 400, 1.5 line height.
- Micro labels: Inter 11–12px, 500, sentence case or restrained uppercase, `0.03em` tracking.
- Proof data: Plex Mono 13px with tabular figures when available.
- Keep main question width around 480px in marketing contexts. In poll detail, let the question breathe but retain a readable measure.

## Layout

Retain the reference’s outer device-frame composition: an outer 24px rounded container sits on Soft Fog, with generous 48px desktop / 20px mobile page padding and 64–80px section rhythm.

### Navigation

Keep the pill-shaped/borderless top bar:

- left: small circular Signal Gold Votum mark + wordmark;
- center: `Explore · Create` or `Polls · Create`;
- right: a compact reward-status pill and a circular utility icon.

### Hero

Keep the 45/55 asymmetric layout. Change the content:

  - **left:** a `↗ VERIFIED COMMUNITY DECISIONS` eyebrow, headline, concise explanation, Create / Explore pill CTAs, and a horizontal proof strip;
- **right:** a high-fidelity 3D **Proof Ballot** render with floating glass cards.

### Product visual direction

Retain the reference’s high-production 3D, frosted/glass material visual quality and photographic light—not its charging-station/moss subject.

The hero image is a sculptural, tactile ballot object: a matte Ballot Ink voting slab or paper-like card entering a clear chamber, with one Signal Gold NIM marker, subtle transparent layers and a restrained NIM Blue proof trace. A floating card can read `Vote verified` and another can show `84 verified wallets · reward available`.

Do not use generic ballot-box stock photos, cartoon polls, floating coin piles, a crypto city, neon chains, or a literal “community people” illustration. The product outcome—not token decoration—is the visual subject.

### Signature motif: Proof Path

Use a minimal diagonal path, derived from the reference’s `↗` mark:

  > **question ↗ choice ↗ verified vote ↗ result**

It can appear as a label sequence, a small proof line, or as the structure inside a receipt. Never turn it into an orbit, network mesh, candlestick chart or decorative arrow field.

### Main product surface: Signal Poll

A new reward-first poll screen follows this hierarchy:

1. Question.
2. Participation model: free verified poll or rewarded participation.
3. Option selection.
4. Fairness rule: `ONE WALLET · ONE VOTE`.
5. Primary `Cast vote` CTA.
6. Live verified result and, only when funded, the safe reward offer.

Historical `legacy_support` polls may additionally render the support hierarchy:

1. What the contribution supports.
2. Visible destination wallet/purpose.
3. Minimum NIM amount.
4. Option selection and the legacy support CTA.

## Components

Keep the reference mechanics—pills, generous radii, barely-there elevation, and light glass overlays—while applying Votum’s meaning.

### Buttons

- **Primary:** Signal Gold fill, Ballot Ink text, 999px radius, flat/no shadow, 13–14px medium-weight label. Hover: Deep Gold only; no lift/scale.
- **Secondary:** Soft Fog fill, 1px `#DEDEDE` outline, Ballot Ink text, pill shape. It visually reads as a quiet background-matched control rather than a second CTA. Hover: `rgba(0,0,0,0.02)` tint.
- **Verified state:** Verified Green fill with white text and an explicit check icon. It is a status/result, not a default CTA.
- **Icon utility:** circular Soft Fog / white surface, 1px border, 16px monochrome icon.

### Cards and containers

- Preserve Clear Ballot card, 20–24px radius, 1px `#E3E3E3` border, and soft `0 4px 16px rgba(0,0,0,0.04)` elevation.
- Floating overlay cards may use 85–90% white + backdrop blur over the Proof Ballot render.
- Use a 24px large panel for the poll detail / result surface.
- Use 20px floating cards for payment status and proof summary.
- Use 999px only for buttons, tags and compact status pills—not every data label.

### Result display

Show verified participation and reward status in clear, separate formats. Legacy support results may additionally show the support measure:

> **Result cards leads**  
> `51 verified wallets · Reward: 0.01 NIM when funded`

Do not call the NIM total “winning money.” Do not show odds, payout or pot terminology.

### Votum Receipt

A shareable, data-minimised proof surface:

> **Your verified vote is recorded**
> `Result cards · 14:26 UTC`

Legacy support receipts may retain their NIM amount and transaction reference.

It must never reveal full wallet data in a public share image.

## Elevation & Depth

Retain the reference’s calm depth system:

| Treatment | Use |
|---|---|
| Flat | Background, nav labels, microcopy and dividers |
| Soft elevation `0 4px 16px rgba(0,0,0,0.04)` | Standard cards and feature strips |
| Glass overlay | Floating `Vote verified` and, only for legacy context, NIM-support cards over hero/product render |

No blur-heavy cards, deep shadows, neumorphism, hard sticker shadows or animated elevation.

## Do's and Don'ts

### Do

- Keep Soft Fog background, premium neutral field, typography direction, rounded pill controls, light cards and high-fidelity 3D render quality from the reference.
- Make the question and the explicit NIM destination more prominent than the total NIM raised.
- Use Gold for a decision/action; Blue for proof; Green only for verified completion.
- Use the diagonal `↗` and Proof Path as a quiet recognisable asset.
- Show wallet count and reward status separately in every reward-first result; legacy results may additionally show NIM support.
- State reward terms before voting; legacy support destinations before payment.

### Don't

- Do not reuse EV chargers, moss, sustainability imagery, leaf icons, certification-badge language or green-energy product visuals.
- Do not create casino, prediction-market or dark DeFi visual codes.
- Do not let colour alone communicate a vote, status or fairness rule.
- Do not use generic AI gradients, token rain, neon or full-page charts.
- Do not imply that creator-wallet payments automatically escrow funds for the winning option.
- Do not crowd the app with cards; the Signal Poll itself is the primary surface.

## Responsive behaviour

- Hero stacks below 1024px with Proof Ballot render below the text.
- Navigation center links collapse below 768px; mark, primary action and utility remain accessible.
- Feature strip stacks or scrolls horizontally on mobile.
- Poll choice targets remain at least 44px high.
- Full destination-wallet information opens through accessible truncation/copy behaviour rather than shrinking into illegible text.
- Keep CTAs content-width on mobile unless the poll vote action needs a clear full-width final confirmation.
