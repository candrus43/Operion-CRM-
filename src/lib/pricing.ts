/**
 * Operion subscription pricing — the single source of truth for deal value.
 *
 * Every deal in the pipeline is an Operion subscription sale. The plan is the
 * ONLY pricing input a user ever sets; everything else (setup fee, MRR, annual
 * value, first-year value) is computed here from the plan constants — never
 * stored in the DB, never typed by a user.
 *
 * Plain module with NO imports (server or client): safe to use from client
 * components, server functions, and seed code alike.
 */

export const PLANS = ["Founder", "Studio"] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanPricing {
  /** One-time setup fee (USD). */
  setupFee: number;
  /** Monthly recurring revenue (USD/month). */
  mrr: number;
}

/** Owner-specified pricing — do not invent other numbers. */
export const PLAN_PRICING: Record<Plan, PlanPricing> = {
  Founder: { setupFee: 2500, mrr: 249 },
  Studio: { setupFee: 5000, mrr: 499 },
};

/** Stage → probability used for weighted pipeline reporting (0..1). */
export const STAGE_PROBABILITY: Record<string, number> = {
  Lead: 0.1,
  Contacted: 0.25,
  Meeting: 0.4,
  Proposal: 0.6,
  Negotiation: 0.8,
  "Closed Won": 1,
  "Closed Lost": 0,
};

/**
 * Commission rate on Closed Won deals — a flat 25% of the COLLECTED setup fee.
 * Commission is computed from the plan only, never typed (see `commissionFor`).
 */
export const COMMISSION_RATE = 0.25;

/** Agent commission for a plan = 25% of the plan's setup fee (Founder 625, Studio 1250). */
export function commissionFor(plan: Plan): number {
  return PLAN_PRICING[plan].setupFee * COMMISSION_RATE;
}

/** Annual value = MRR × 12. Always computed, never stored. */
export function annualValue(plan: Plan): number {
  return PLAN_PRICING[plan].mrr * 12;
}

/** Total first-year value = setup fee + annual value. Always computed, never stored. */
export function firstYearValue(plan: Plan): number {
  return PLAN_PRICING[plan].setupFee + annualValue(plan);
}

/** True when `p` is a known plan name (validation helper). */
export function isPlan(p: unknown): p is Plan {
  return p === "Founder" || p === "Studio";
}
