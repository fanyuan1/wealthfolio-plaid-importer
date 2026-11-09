// After a push: what the user still does by hand in Wealthfolio, from the plan's review rows.
import { plural, type Review } from "./models";

// reason -> [heading, instruction]. Reasons not listed fall into OTHER.
const SECTIONS: [string, string | null, string | null][] = [
  [
    "opening cost basis missing",
    "Opening cost basis",
    "Plaid has no cost for these positions held before the history starts. Wealthfolio has them at the price shown. Change the unit price of the opening activity if your statements show a different cost."
  ],
  [
    "vest price unknown",
    "Vests without a price",
    "No market close was found. Set the unit price of each vest to the price on its date."
  ],
  [
    "negative opening position",
    "Positions that do not add up",
    "The pulled history does not match the holdings. Compare the quantity with your broker. Add or edit activities in Wealthfolio until they match. Ignore differences under 0.01 shares."
  ],
  [
    "holdings mismatch",
    null,
    null
  ],
  [
    "ratio change to confirm",
    "Exchange ratios to confirm",
    "The reported price moves the ratio more than usual, so the old ratio was kept. Confirm or correct it in Sync → Securities."
  ],
  [
    "no market data",
    "Securities Wealthfolio cannot price",
    "Their value stays at the last activity price. In Sync → Securities, choose Follow ticker, or type the right ticker."
  ],
  [
    "no holdings from Plaid",
    "Accounts with a balance but no holdings",
    "The institution does not share positions through Plaid. Add the positions in Wealthfolio from a statement, or import the institution's CSV export."
  ],
  [
    "unmapped security",
    "Securities without a ticker",
    "In Sync → Securities, type a ticker, or choose Price from activities."
  ],
  [
    "possible brokerage window",
    "Possible duplicate accounts",
    "If this fund mirrors another linked account, choose Leave out for it in Sync → Securities."
  ]
];
const OTHER: [string, string] = ["Activities to add by hand", "Plaid did not give enough detail to import these. Add them in Wealthfolio from your statements."];

/** The to-do list's lines: a heading, an instruction, then the items. Empty when there is nothing to do. */
export function todoReport(reviews: Review[], names: Record<string, string>, priceWarnings: string[] = []): string[] {
  const lines = priceWarnings.map((w) => `Warning: ${w}`);
  const known = new Set(SECTIONS.map(([r]) => r));
  const groups = new Map<string, Review[]>();
  for (const r of reviews) {
    const key = known.has(r.reason) ? r.reason : "other";
    const g = key === "holdings mismatch" ? "negative opening position" : key;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  const sections: [string, string, string][] = [
    ...SECTIONS.filter(([, h]) => h).map(([r, h, t]) => [r, h!, t!] as [string, string, string]),
    ["other", ...OTHER],
  ];
  const name = (id: string) => names[id] ?? id;
  let n = 0;
  for (const [reason, heading, text] of sections) {
    const rows = groups.get(reason);
    if (!rows) continue;
    n += rows.length;
    lines.push("", `${heading} (${rows.length})`, `  ${text}`);
    const sorted = [...rows].sort((a, b) => (name(a.accountId) + "\0" + a.date < name(b.accountId) + "\0" + b.date ? -1 : 1));
    for (const r of sorted) {
      const when = r.date ? `${r.date} ` : "";
      const what = reason === "other" || r.reason === "holdings mismatch" ? `${r.reason}: ` : "";
      lines.push(`  - ${name(r.accountId)}: ${when}${what}${r.detail}`);
    }
  }
  if (n) lines.splice(priceWarnings.length, 0, `To do in Wealthfolio: ${plural(n, "item")}`);
  return lines;
}

export interface TodoGroup { heading: string; count: number; text: string; items: string[]; warning?: boolean }

/** todoReport's lines (and the engine's kept-rows lines) read back as groups: a heading "Name (n)", an indented instruction, then "  - item" lines. */
export function todoGroups(lines: string[]): TodoGroup[] {
  const out: TodoGroup[] = [];
  for (const raw of lines) {
    const l = raw.replace(/^\n/, '');
    if (!l.trim() || /^To do in Wealthfolio:/.test(l)) continue;
    if (l.startsWith('Warning: ')) { out.push({ heading: 'Price lookup', count: 0, text: l.slice(9), items: [], warning: true }); continue; }
    const head = /^(\S.*) \((\d+)\)$/.exec(l);
    if (head) { out.push({ heading: head[1], count: Number(head[2]), text: '', items: [] }); continue; }
    const g = out[out.length - 1];
    if (!g) continue;
    if (l.startsWith('  - ')) g.items.push(l.slice(4));
    else g.text = (g.text ? `${g.text} ` : '') + l.trim();
  }
  return out;
}
