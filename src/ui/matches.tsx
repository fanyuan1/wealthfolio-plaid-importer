// Sync, first push to an account: check the rows Plaid would add against what Wealthfolio already has.
// Three groups: new, similar, exact. New rows start as Add; exact and similar start as Discard.
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Icons, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@wealthfolio/ui';
import { Fragment, useState } from 'react';
import type { Adoption } from '../importer';

const PAGE = 50;
type How = Adoption['how'];
const HOW: Record<How, string> = { similar: 'Similar', exact: 'Exact', new: 'New' };
const ORDER: How[] = ['new', 'similar', 'exact'];
const line = (r: { date: string; type: string; symbol: string | null; amount: string | null; quantity: string | null }) =>
  `${r.date} · ${r.type}${r.symbol ? ` ${r.symbol}` : ''} · ${r.quantity && r.symbol ? `${r.quantity} sh` : (r.amount ?? '—')}`;

export function Matches({ list, names, onChange }: { list: Adoption[]; names: Record<string, string>; onChange: (next: Adoption[]) => void }) {
  const [toggled, setToggled] = useState<Partial<Record<How, boolean>>>({}); // the user's own open/close
  const [compare, setCompare] = useState<string>(); // key of the row shown side by side
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Partial<Record<How, number>>>({});
  if (!list.length) return null;
  const set = (keys: Set<string>, decision: Adoption['decision']) => {
    onChange(list.map((a) => (keys.has(a.key) ? { ...a, decision } : a)));
    setPicked(new Set());
  };
  const adding = list.filter((a) => a.decision === 'add').length;
  const flip = (k: Set<string>, key: string) => { const n = new Set(k); if (!n.delete(key)) n.add(key); return n; };

  return (
    <Card>
      <CardHeader className="space-y-0">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-lg">Check for duplicates ({adding} to add, {list.length - adding} to discard)</CardTitle>
          <CardDescription>
            The addons have not seen these transactions, so Wealthfolio may already hold some of these rows.
            New rows will be added. Similar and exact matches are discarded unless you choose Add.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col p-0 pb-2">
        {ORDER.map((how) => {
          // Newest first; the order never depends on the choice, so a row stays where it is when you decide.
          const rows = list.filter((a) => a.how === how).sort((a, b) => b.row.date.localeCompare(a.row.date) || a.key.localeCompare(b.key));
          if (!rows.length) return null;
          const open = toggled[how] ?? true;
          const added = rows.filter((a) => a.decision === 'add').length;
          const mine = new Set(rows.filter((a) => picked.has(a.key)).map((a) => a.key));
          const pick = (keys: string[]) => setPicked((p) => new Set([...[...p].filter((k) => !rows.some((a) => a.key === k)), ...keys]));
          const limit = shown[how] ?? PAGE;
          return (
            <div key={how} className="border-t">
              <button type="button" className="hover:bg-muted/50 flex w-full items-center gap-2 px-6 py-3 text-left"
                      onClick={() => setToggled((t) => ({ ...t, [how]: !open }))}>
                {open ? <Icons.ChevronDown className="h-4 w-4" /> : <Icons.ChevronRight className="h-4 w-4" />}
                <span className="font-medium">{HOW[how]}</span>
                <Badge variant="secondary">{rows.length}</Badge>
                <Badge variant={added ? 'info-subtle' : 'secondary'}>{added} to add</Badge>
              </button>
              {open && (
                <>
                  <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
                    <Button size="sm" variant="outline" onClick={() => pick(rows.map((a) => a.key))}>Select all</Button>
                    <Button size="sm" variant="outline" disabled={!mine.size} onClick={() => pick([])}>Clear</Button>
                    <span className="text-muted-foreground text-sm">{mine.size} selected</span>
                    <Button size="sm" disabled={!mine.size} onClick={() => set(mine, 'add')}>Add</Button>
                    <Button size="sm" disabled={!mine.size} onClick={() => set(mine, 'discard')}>Discard</Button>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10 pl-6"></TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead>From Plaid</TableHead>
                        <TableHead>Already in Wealthfolio</TableHead>
                        <TableHead className="pr-6 text-right"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.slice(0, limit).map((a) => (
                        <Fragment key={a.key}>
                        <TableRow>
                          <TableCell className="pl-6">
                            <input type="checkbox" aria-label="Select" checked={picked.has(a.key)} onChange={() => setPicked((p) => flip(p, a.key))} />
                          </TableCell>
                          <TableCell>{names[a.accountId] ?? a.accountId}</TableCell>
                          <TableCell>{line(a.row)}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {a.existing ? line(a.existing)
                              : a.held !== undefined ? `Holds ${a.held} sh before ${a.row.date}${a.how === 'exact' ? ' · same as Plaid' : ''}` : '—'}
                          </TableCell>
                          <TableCell className="pr-6 text-right">
                            <div className="flex justify-end gap-2">
                              {a.how !== 'new' && (
                                <Button size="sm" variant="ghost" onClick={() => setCompare(compare === a.key ? undefined : a.key)}>
                                  {compare === a.key ? 'Hide' : 'Compare'}
                                </Button>
                              )}
                              <Button size="sm" variant={a.decision === 'add' ? 'default' : 'outline'} onClick={() => set(new Set([a.key]), 'add')}>Add</Button>
                              <Button size="sm" variant={a.decision === 'discard' ? 'default' : 'outline'} onClick={() => set(new Set([a.key]), 'discard')}>Discard</Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {compare === a.key && (
                          <TableRow>
                            <TableCell colSpan={5} className="px-6"><Versions a={a} /></TableCell>
                          </TableRow>
                        )}
                        </Fragment>
                      ))}
                    </TableBody>
                  </Table>
                  {rows.length > limit && (
                    <div className="p-3 text-center">
                      <Button size="sm" variant="ghost" onClick={() => setShown((s) => ({ ...s, [how]: limit + PAGE }))}>Show more ({rows.length - limit} left)</Button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** Plaid's version beside Wealthfolio's; differences are marked. An opening row lists the activities it is compared with. */
function Versions({ a }: { a: Adoption }) {
  if (!a.existing) {
    const parts = a.parts ?? [];
    return (
      <div className="flex flex-col gap-2 py-2 text-sm">
        <span>Plaid opening: <b>{a.row.quantity ?? '—'} sh</b> {a.row.symbol} on {a.row.date}</span>
        <span>Wealthfolio holds before that date: <b>{a.held ?? 0} sh</b> from {parts.length} activit{parts.length === 1 ? 'y' : 'ies'}:</span>
        <ul className="text-muted-foreground list-disc pl-5">
          {parts.slice(0, 20).map((e) => <li key={e.id}>{line(e)}</li>)}
          {parts.length > 20 && <li>… {parts.length - 20} more</li>}
        </ul>
      </div>
    );
  }
  const e = a.existing;
  const rows: [string, string | null | undefined, string | null | undefined, boolean][] = [
    ['Date', a.row.date, e.date, true], ['Type', a.row.type, e.type, true], ['Ticker', a.row.symbol, e.symbol, true],
    ['Quantity', a.row.quantity, e.quantity, true], ['Amount', a.row.amount, e.amount, true], ['Note', a.row.description, e.comment, false]];
  const num = (v?: string | null) => (v != null && v !== '' && !isNaN(Number(v)) ? String(Number(v)) : (v ?? ''));
  return (
    <table className="my-2 w-full max-w-2xl text-sm">
      <thead><tr className="text-muted-foreground text-left"><th className="w-24 font-normal"></th><th className="font-normal">Plaid</th><th className="font-normal">Wealthfolio</th></tr></thead>
      <tbody>
        {rows.map(([k, p, w, mark]) => (
          <tr key={k} className={mark && num(p) !== num(w) ? 'font-medium text-amber-600' : ''}>
            <td className="text-muted-foreground py-0.5">{k}</td><td>{p || '—'}</td><td className="break-all">{w || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
