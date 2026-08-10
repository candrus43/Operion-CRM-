/**
 * Operion CRM — canonical resource library documents (server-side seed data).
 *
 * These are REAL team collateral, not demo rows: the pricing sheet, the sales
 * playbook, and the objection-handling guide that the owner asked to ship with
 * the library. Every figure is grounded in the pricing constants in
 * `~/lib/pricing` (Founder/Studio setup fees, MRR, annual and first-year
 * values) and the closing handoff defined in `~/lib/pipeline` (markWon →
 * Operion send-payment-link). Nothing here is invented; there is no fake
 * urgency or unverifiable product claim.
 *
 * The module is imported only from `~/lib/auth-core` (server-only), where
 * `seedResourcesIfNeeded` inserts each document as a `text/markdown` resource
 * (uploader NULL → shown as "Operion team") the first time the resources table
 * is created/upgraded.
 */

export interface ResourceSeed {
  title: string;
  category: string;
  description: string;
  fileName: string;
  fileType: string;
  content: string;
}

export const RESOURCE_SEEDS: ResourceSeed[] = [
  {
    title: "Operion pricing sheet",
    category: "Pricing",
    description:
      "The two plans we sell — Founder and Studio — with setup fees, monthly recurring revenue, annual value, first-year value, and the agent commission on each close.",
    fileName: "operion-pricing-sheet.md",
    fileType: "text/markdown",
    content: `# Operion pricing sheet

Operion sells two subscription plans. Every deal in the pipeline is a sale of one of these two plans — there is no custom pricing and no room to negotiate the numbers below. The CRM computes setup fee, MRR, annual value and first-year value from the plan automatically; you never type a dollar amount.

## Plans

| | **Founder** | **Studio** |
| --- | --- | --- |
| One-time setup fee (due at signup) | $2,500 | $5,000 |
| Monthly recurring (MRR) | $249 / month | $499 / month |
| Annual value (MRR × 12) | $2,988 | $5,988 |
| **Total first-year value** | **$5,239** | **$10,489** |

## How billing works (owner-ratified)
- **At signup the customer pays ONLY the setup fee** — there is no monthly charge at signup.
- **The monthly subscription starts billing 31 days later**: the first monthly charge lands on day 31 after signup.
- **First-year total = setup fee + 11 monthly charges** — that is the cash a new customer pays in year 1: Founder $2,500 + 11 × $249 = **$5,239**; Studio $5,000 + 11 × $499 = **$10,489**.
- **Annual value (MRR × 12)** is the contract/ARR metric — Founder $2,988, Studio $5,988 — and is intentionally different from the first-year cash total.
- **After year 1** the customer pays only the monthly MRR.

## Agent commission

Commission is **25% of the collected setup fee** on Closed Won deals — the only commission we pay. It is earned when the customer pays the setup fee, not when the deal closes. The setup fee is still collected at signup, so the commission is unchanged by the billing schedule.

| Plan | Setup fee | Commission (25%) |
| --- | --- | --- |
| Founder | $2,500 | $625 |
| Studio | $5,000 | $1,250 |

- Mark the setup fee as collected in the CRM once the customer confirms payment — that is what puts the commission on your ledger.
- The owner can mark or undo a collection on any deal; agents can mark their own deals but cannot undo a mark.

## Quick reference

| Question | Answer |
| --- | --- |
| What does the customer pay at signup? | Only the one-time setup fee (Founder $2,500, Studio $5,000). |
| When does the monthly subscription start? | 31 days after signup — the first monthly charge lands on day 31. |
| What is the first-year total? | Setup + 11 months: Founder $5,239, Studio $10,489. |
| What is the annual value? | MRR × 12: Founder $2,988, Studio $5,988. |
| What does a Founder close earn? | $625 once the setup fee is collected. |
| What does a Studio close earn? | $1,250 once the setup fee is collected. |
`,
  },
  {
    title: "Sales playbook",
    category: "Playbooks",
    description:
      "The end-to-end selling process: the seven pipeline stages, the default stage probabilities that drive weighted pipeline reporting, and the closing handoff where Operion emails the customer a Stripe payment link.",
    fileName: "sales-playbook.md",
    fileType: "text/markdown",
    content: `# Operion sales playbook

The playbook covers the whole journey of a deal — from first lead to closed won or lost. Every deal starts as a subscription sale of Founder ($2,500 setup + $249/mo) or Studio ($5,000 setup + $499/mo), and pricing is set by the plan; nothing else is negotiable.

## The pipeline

Deals move through seven stages. Each stage has a default probability used to compute the weighted pipeline (MRR × probability) — that is how we forecast, so keep stages honest.

| Stage | Probability | What it means |
| --- | --- | --- |
| Lead | 10% | A prospect identified, not yet contacted. |
| Contacted | 25% | First outreach done, conversation started. |
| Meeting | 40% | A discovery or demo meeting happened. |
| Proposal | 60% | A proposal was shared. |
| Negotiation | 80% | Commercial terms are being worked through. |
| Closed Won | 100% | Customer signed and the payment link was sent. |
| Closed Lost | 0% | The deal is dead — record why in the notes. |

## Stage-by-stage guidance

1. **Lead** — capture the company, a contact name and email, and the plan you expect (Founder or Studio). If you don't know the plan yet, default to Founder and correct it later.
2. **Contacted** — first outreach done. Log the next step so the deal never goes quiet.
3. **Meeting** — discovery call or demo. Confirm the plan size and the decision-maker's email — you need a customer email before you can close.
4. **Proposal** — share the pricing sheet (see the *Operion pricing sheet* resource) and the total first-year value for the plan.
5. **Negotiation** — work through objections (see the *Objection handling guide*). Pricing is fixed — there are no discounts — but you can anchor on annual value vs. setup fee.
6. **Closed Won** — use **Mark Won** in the CRM. This hands off to Operion: Operion emails the customer a Stripe payment link for the plan's setup fee (the subscription starts billing automatically 31 days later), and owns all payment. The deal moves to Closed Won **only when Operion accepts the handoff**.
7. **Closed Lost** — be honest. Log why it lost in the deal notes so the pipeline data stays truthful.

## Closing handoff (Mark Won)

Closing happens **inside the CRM, and the CRM never touches money**:

1. The deal must be in **Negotiation** and have a customer email (either on the deal or on its linked contact). Without an email, Mark Won will refuse and tell you to add one.
2. Click **Mark Won** — the CRM confirms with you, then POSTs to Operion's \`/api/crm/send-payment-link\` endpoint with the customer email, customer name and plan.
3. Operion emails the customer from hello@operion.online with the correct Stripe payment link for the plan (setup fee at signup; the subscription starts billing 31 days later) and handles the payment.
4. The deal moves to **Closed Won** only when Operion returns success. If Operion is unreachable or returns an error, the deal **stays in Negotiation** and the CRM shows the error — just retry. A deal is never marked won until the payment link actually went out.

After the customer pays the setup fee, mark **setup fee collected** on the deal — that earns your commission (25% of the setup fee: $625 Founder, $1,250 Studio).

## Pipeline math

- **Pipeline MRR** = sum of MRR across open deals (Lead → Negotiation).
- **Weighted pipeline** = sum of MRR × stage probability.
- **Closed-won MRR** = MRR of deals closed this month/quarter.
- **Win rate** = Closed Won ÷ (Closed Won + Closed Lost).

Keep deal data current — a stale stage or missing email hurts the forecast and blocks closing.
`,
  },
  {
    title: "Objection handling guide",
    category: "Playbooks",
    description:
      "How to answer the common hesitations — price, setup fee, budget, competitors, timing — with truthful, grounded responses. No discounts, no invented claims, no pressure tactics.",
    fileName: "objection-handling-guide.md",
    fileType: "text/markdown",
    content: `# Objection handling guide

The goal of objection handling is not to win an argument — it is to make sure the prospect is deciding on accurate information. Everything below is grounded in the actual pricing and process; if a prospect asks something you don't know, say you'll confirm rather than invent an answer.

**Ground rules**

- Pricing is fixed: Founder is $2,500 setup + $249/month; Studio is $5,000 setup + $499/month. There are no discounts, no trial extensions and no "special" rates.
- Never create urgency that isn't real. No "spots are filling up", no "price goes up tomorrow", no expiring offers.
- If a claim isn't in the pricing sheet or playbook, don't make it.

## 1. "It's more than we expected" (price)

**What's really happening:** the prospect is comparing the total against what they imagined, or they only saw the monthly number.

**Response:** Walk them through the full value, not just the sticker price.

- Founder: $2,500 one-time setup at signup, then $249/month from day 31 — $5,239 total first-year outlay (setup + 11 monthly charges), $2,988 annual contract value.
- Studio: $5,000 setup at signup, then $499/month from day 31 — $10,489 total first-year outlay, $5,988 annual contract value.
- The setup fee is a one-time cost paid at signup; the monthly subscription starts billing 31 days later. After the first year the customer pays only the monthly MRR.

## 2. "Why is there a setup fee?" (setup fee)

**What's really happening:** the prospect doesn't understand what the one-time fee is for, or wants it waived.

**Response:** The setup fee is a one-time charge for getting the customer live on Operion — it is part of every plan, Founder and Studio alike, and it is not negotiable. Frame it as the price of going live; the monthly fee then covers the ongoing subscription.

## 3. "We don't have budget right now" (no budget)

**What's really happening:** either the budget genuinely isn't there, or the prospect hasn't made this a priority.

**Response:** Be honest and useful:

- Share the exact first-year cost so they can evaluate it against real numbers: $5,239 (Founder) or $10,489 (Studio) total first-year outlay — the setup fee is $2,500/$5,000 paid at signup, then 11 monthly charges of $249/$499 (billing starts 31 days after signup). Annual contract value is $2,988/$5,988 (MRR × 12).
- If it's a timing issue, agree on a concrete next step (a specific date to re-connect) and update the deal's next step in the CRM — don't leave it vague.
- If the budget truly isn't there, that's a Closed Lost with an honest note, not a deal to push.

## 4. "We're looking at a competitor" (competitor)

**What's really happening:** the prospect is comparing options and wants a reason to choose Operion.

**Response:** You can talk about Operion's own facts — the two plans, the one-time setup + monthly subscription structure, and the total first-year cost. What you can't do is trash a competitor or make claims about them. Ask what matters most to them (cost, timeline, fit) and show how Operion's numbers line up against those priorities.

## 5. "We'll wait / not right now" (timing)

**What's really happening:** no urgency, or the prospect is stalling.

**Response:** No manufactured urgency — ever. Instead:

- Make the cost concrete so they can decide: Founder $5,239 / Studio $10,489 first-year total.
- Ask what would make the timing right, and put that in the deal notes as the next step.
- If they need time, set the deal to a stage that reflects reality (or Closed Lost with a note) rather than letting it sit in Negotiation forever — stale deals hurt the forecast.

## After the objection

Whatever the outcome, update the deal: keep the stage accurate, record the objection in the notes, and set a next step. If the prospect is ready to move, get them to Negotiation and use **Mark Won** — Operion sends the payment link by email and handles the money.
`,
  },
];
