import { type Dec, ZERO } from "./dec";

export const POSITION_SIGN: Record<string, number> = { BUY: 1, TRANSFER_IN: 1, SELL: -1, TRANSFER_OUT: -1 };
export const CASH_IN = new Set(["DEPOSIT", "TRANSFER_IN", "DIVIDEND", "INTEREST", "CREDIT"]);
export const CASH_OUT = new Set(["WITHDRAWAL", "TRANSFER_OUT", "FEE", "TAX"]);

export interface ActivityInit {
  accountId: string;
  plaidId: string;
  date: string;
  activityType: string;
  currency?: string;
  symbol?: string | null;
  instrumentType?: string | null;
  quantity?: Dec | null;
  unitPrice?: Dec | null;
  amount?: Dec | null;
  fee?: Dec | null;
  tax?: Dec | null;
  subtype?: string | null;
  description?: string;
  category?: string | null;
  transferHint?: boolean;
  splitDelta?: Dec | null;
  pairId?: string | null;
  securityId?: string | null;
  symbolName?: string | null;
  quoteManual?: boolean;
  marketPrice?: boolean;
}

export class Activity {
  accountId!: string;
  plaidId!: string;
  date!: string;
  activityType!: string;
  currency = "USD";
  symbol: string | null = null;
  instrumentType: string | null = null;
  quantity: Dec | null = null;
  unitPrice: Dec | null = null;
  amount: Dec | null = null;
  fee: Dec | null = null;
  tax: Dec | null = null;
  subtype: string | null = null;
  description = "";
  category: string | null = null;
  transferHint = false;
  splitDelta: Dec | null = null;
  pairId: string | null = null;
  securityId: string | null = null;
  symbolName: string | null = null;
  quoteManual = false;
  marketPrice = false;

  constructor(init: ActivityInit) {
    Object.assign(this, Object.fromEntries(Object.entries(init).filter(([, v]) => v !== undefined)));
  }

  get comment(): string {
    return `${this.description} · plaid:${this.plaidId}`.replace(/^[ ·]+|[ ·]+$/g, "");
  }

  get isCashOnly(): boolean {
    return this.symbol === null;
  }

  positionDelta(): Dec {
    if (this.activityType === "SPLIT") return this.splitDelta ?? ZERO;
    const sign = POSITION_SIGN[this.activityType];
    if (sign === undefined || this.symbol === null || this.quantity === null) return ZERO;
    return this.quantity.times(sign);
  }

  cashDelta(): Dec {
    const t = this.activityType;
    const fee = this.fee ?? ZERO;
    if (t === "BUY" || t === "SELL") {
      const gross = this.amount ?? (this.quantity ?? ZERO).times(this.unitPrice ?? ZERO);
      return t === "BUY" ? gross.plus(fee).neg() : gross.minus(fee);
    }
    if (this.symbol !== null && (t === "TRANSFER_IN" || t === "TRANSFER_OUT")) return ZERO;
    if (CASH_IN.has(t)) return this.amount ?? ZERO;
    if (CASH_OUT.has(t)) return (this.amount ?? ZERO).neg();
    return ZERO;
  }
}

export interface Review {
  accountId: string;
  plaidId: string;
  date: string;
  reason: string;
  detail: string;
}

export const review = (at: Pick<Review, "accountId" | "plaidId" | "date">, reason: string, detail = ""): Review => ({ ...at, reason, detail });

export interface MapResult {
  activities: Activity[];
  reviews: Review[];
  cancelledIds: Set<string>;
  unmappedSecurities: Map<string, string>;
}

export const mapResult = (): MapResult => ({
  activities: [], reviews: [], cancelledIds: new Set(), unmappedSecurities: new Map(),
});


export interface Progress {
  id: string; label: string; parent?: string;
  state: "running" | "done" | "warn" | "error" | "skipped";
  detail?: string | undefined;
}
export type OnProgress = (p: Progress) => void;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
