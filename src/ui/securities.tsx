// Sync → Securities: how each security maps.
import { Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@wealthfolio/ui';
import { Fragment, useEffect, useState } from 'react';
import { type Engine, modeOf, type Security, type SecurityMode } from '../engine/engine';
import type { Track } from '../importer';
import { Problem, Spin, useBusy } from './common';

const MODES: [SecurityMode, string, string][] = [
  ['auto', 'Automatic', "Uses your bank's ticker. Wealthfolio gets the prices."],
  ['ticker', 'Input ticker', "Type the ticker. One share must be worth that ticker's price."],
  ['track', 'Follow ticker', 'No quotes of its own. Priced from another ticker, times a ratio.'],
  ['manual', 'Price from activities', 'No quotes. The value changes only when a buy, sell or dividend comes in.'],
  ['cash', 'Cash', 'Counts it as cash in the account.'],
  ['holding', 'Money Market Fund', 'Keeps a cash-like fund as a holding, not cash.'],
  ['exclude', 'Leave out', 'Drops it and its activities. Use it for a duplicate from another account.'],
];

type Tone = 'success-subtle' | 'destructive';

/** Source column. The dry run decides which securities need review (needsReview). A source the user chose counts once
 * the preview was refreshed with it; an Automatic ticker Wealthfolio refused in the last push needs review again.
 * Blank: needs review. */
function sourceOf(s: Security, refused: Record<string, string> = {}): { label: string; tone: Tone } | null {
  const mode = modeOf(s);
  if (s.pending || s.review || (mode === 'auto' && refused[s.result])) return null;
  const label = MODES.find(([m]) => m === mode)![1];
  return { label, tone: mode === 'exclude' ? 'destructive' : 'success-subtle' };
}

export type Saved = (sid: string, override: Record<string, unknown>, label: string) => void;

/** refused: symbols Wealthfolio did not save in the last push, with its reason. They need attention whatever the lookup says. */
export function Securities({ engine, list, refused = {}, onSaved, onAttention }: { engine: Engine; list: Security[]; refused?: Record<string, string>;
  onSaved: Saved; onAttention: (n: number) => void }) {
  const [open, setOpen] = useState<string>();
  const attention = list.filter((s) => !sourceOf(s, refused));
  useEffect(() => { onAttention(attention.length); }, [attention.length, onAttention]);
  useEffect(() => () => onAttention(0), [onAttention]); // unmounted: nothing left to review
  const ok = list.filter((s) => sourceOf(s, refused));
  const section = (title: string, rows: Security[], action: string) => rows.length > 0 && (
    <>
      <TableRow className="bg-muted/50 hover:bg-muted/50">
        <TableCell colSpan={5} className="px-6 text-sm font-medium">{title} ({rows.length})</TableCell>
      </TableRow>
      {rows.map((s) => {
        const src = sourceOf(s, refused);
        return (
          <Fragment key={s.sid}>
            <TableRow>
              <TableCell className="ps-6">
                {s.name}
                {refused[s.result] && !s.pending && <div className="text-destructive text-xs">Wealthfolio refused it: {refused[s.result]}</div>}
              </TableCell>
              <TableCell>{s.ticker ?? '—'}</TableCell>
              <TableCell>
                {s.pending ? <Badge variant="info-subtle">✓ {s.pending} saved · update the preview</Badge>
                  : s.result === 'unmapped' ? <span className="text-muted-foreground">—</span>
                  : <span>{s.result}{s.override?.track ? ` × ${s.override.track.ratio}` : ''}</span>}
              </TableCell>
              <TableCell>{src && <Badge variant={src.tone}>{src.label}</Badge>}</TableCell>
              <TableCell className="pe-6 text-end">
                <Button variant="outline" size="sm" onClick={() => setOpen(s.sid)}>
                  {s.pending ? 'Change' : action}
                </Button>
              </TableCell>
            </TableRow>
          </Fragment>
        );
      })}
    </>
  );
  const editing = list.find((s) => s.sid === open);
  return (
    <Card>
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setOpen(undefined); }}>
        <DialogContent className="max-w-2xl">
          {editing && (
            <>
              <DialogHeader>
                <DialogTitle>{editing.name}</DialogTitle>
                <DialogDescription>Plaid ticker: {editing.ticker ?? 'none'}. Saving turns off Push until you update the preview.</DialogDescription>
              </DialogHeader>
              <SecurityEditor engine={engine} s={editing} onSaved={(o, label) => { setOpen(undefined); onSaved(editing.sid, o, label); }} />
            </>
          )}
        </DialogContent>
      </Dialog>
      <CardHeader>
        <CardTitle className="text-lg">Securities</CardTitle>
        <CardDescription>
          Matching: Automatic where the tickers match and Wealthfolio can look it up. Everything else needs review.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="ps-6">Security</TableHead>
              <TableHead>Plaid ticker</TableHead>
              <TableHead>Wealthfolio ticker</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="pe-6 text-end"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {section('Needs attention', attention, 'Review')}
            {section('Matching', ok, 'Change')}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SecurityEditor({ engine, s, onSaved }: { engine: Engine; s: Security; onSaved: (o: Record<string, unknown>, label: string) => void }) {
  const o = s.override ?? {};
  const [mode, setMode] = useState<SecurityMode>(modeOf(s));
  // A money market fund is a holding with a ticker: default to Plaid's.
  const [symbol, setSymbol] = useState<string>(o.symbol ?? (modeOf(s) === 'holding' || o.investment ? s.ticker ?? '' : ''));
  const [target, setTarget] = useState<string>(o.track?.symbol ?? '');
  const [day, setDay] = useState<string>(s.reported?.[1] ?? o.track?.date ?? '');
  const [price, setPrice] = useState<string>(s.reported?.[0] ?? (o.track ? String(o.track.price) : ''));
  const [close, setClose] = useState<string>('');
  const [track, setTrack] = useState<Track | undefined>(o.track);
  const { busy, error, run } = useBusy();
  // Live check that Wealthfolio knows the typed ticker, or the ticker to follow.
  const [valid, setValid] = useState<{ state: 'idle' | 'checking' | 'ok' | 'bad'; name?: string; suggestions?: { symbol: string; name?: string }[] }>({ state: 'idle' });
  useEffect(() => {
    const sym = mode === 'track' ? target : mode === 'ticker' ? symbol : '';
    if (!sym.trim()) { setValid({ state: 'idle' }); return; }
    setValid({ state: 'checking' });
    let live = true;
    const t = setTimeout(() => {
      engine.validTicker(sym).then((r) => live && setValid(r.ok ? { state: 'ok', name: r.name } : { state: 'bad', suggestions: r.suggestions }))
        .catch(() => live && setValid({ state: 'idle' })); // lookup failed: do not block the user
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [engine, mode, target, symbol]);
  const field = (id: string, label: string, v: string, set: (x: string) => void, ph = '', w = 'w-36') => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} className={w} placeholder={ph} value={v} onChange={(e) => set(e.target.value)} />
    </div>
  );
  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>How to map</Label>
          <TooltipProvider>
            <div className="flex flex-wrap gap-2">
              {MODES.map(([v, l, hint]) => (
                <Tooltip key={v}>
                  <TooltipTrigger render={<Button size="sm" variant={mode === v ? 'default' : 'outline'} onClick={() => setMode(v)} />}>
                    {l}
                  </TooltipTrigger>
                  <TooltipContent>{hint}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </TooltipProvider>
          <span className="text-muted-foreground text-xs">{MODES.find(([v]) => v === mode)![2]}</span>
        </div>
      </div>
      {(mode === 'ticker' || mode === 'manual' || mode === 'holding') &&
        field(`s-${s.sid}`, mode === 'manual' || mode === 'holding' ? 'Ticker (optional)' : 'Ticker', symbol, setSymbol,
          mode === 'manual' ? 'made up if empty' : mode === 'holding' ? (s.ticker ?? 'VMFXX') : 'VFIAX')}
      {mode === 'ticker' && (
        <>
          {/* One line kept for the check result, so the dialog does not grow and shrink while you type. */}
          <div className="min-h-5 text-sm">
            {valid.state === 'checking' && <span className="text-muted-foreground">Checking {symbol} in Wealthfolio…</span>}
            {valid.state === 'ok' && <span className="text-green-600">{symbol.toUpperCase()} has prices{valid.name ? ` (${valid.name})` : ''}.</span>}
            {valid.state === 'bad' && <span className="text-destructive">Wealthfolio does not know {symbol.toUpperCase()}. Try another spelling, or use Price from activities.</span>}
          </div>
          {valid.state === 'bad' && <Suggest list={valid.suggestions} onPick={(x) => setSymbol(x)} />}
        </>
      )}
      {mode === 'cash' && <span className="text-muted-foreground text-xs">Cash has no ticker in Wealthfolio: it is added to the account's cash.</span>}
      {mode === 'track' && (
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-sm">
            Ratio = this fund's price ÷ followed ticker's price on the same day.
            {s.reported && ` Institution price: ${s.reported[0]} on ${s.reported[1]}.`}
          </span>
          <div className="flex flex-wrap items-end gap-3">
            {field(`t-${s.sid}`, 'Ticker to follow', target, (x) => { setTarget(x.toUpperCase()); setTrack(undefined); }, 'VOO', 'w-28')}
            {field(`d-${s.sid}`, 'Date', day, (x) => { setDay(x); setTrack(undefined); }, 'YYYY-MM-DD')}
            {field(`p-${s.sid}`, 'This fund\'s price', price, (x) => { setPrice(x); setTrack(undefined); }, '104.25', 'w-28')}
            {field(`c-${s.sid}`, 'Close (optional)', close, (x) => { setClose(x); setTrack(undefined); }, 'from Yahoo', 'w-28')}
            <Button variant="outline" disabled={!!busy || valid.state === 'bad'} onClick={() => run('ratio', async () => setTrack(await engine.ratio(target, day, price, close)))}>
              <Spin on={busy === 'ratio'} />Get ratio
            </Button>
          </div>
          <div className="min-h-5 text-sm">
            {valid.state === 'checking' && <span className="text-muted-foreground">Checking {target} in Wealthfolio…</span>}
            {valid.state === 'ok' && <span className="text-green-600">{target} is valid in Wealthfolio{valid.name ? ` (${valid.name})` : ''}.</span>}
            {valid.state === 'bad' && <span className="text-destructive">Wealthfolio does not know {target}. Try another ticker.</span>}
          </div>
          {valid.state === 'bad' && <Suggest list={valid.suggestions} onPick={(x) => { setTarget(x); setTrack(undefined); }} />}
          {track && <span className="text-sm">1 unit of {s.name} = {track.ratio} × {track.symbol} (close {track.close} on {track.date}{track.date !== day ? `, the closest day to ${day}` : ''}).</span>}
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={!!busy || (mode === 'track' && !track) || ((mode === 'track' || mode === 'ticker') && valid.state === 'bad')}
                onClick={() => run('save', async () => {
                  const o = await engine.setSecurity(s.sid, s.name, { mode, symbol, track });
                  const name = MODES.find(([m]) => m === mode)![1];
                  onSaved(o, mode === 'ticker' || (mode === 'holding' && o.symbol) ? String(o.symbol) : mode === 'track' ? `${track!.symbol} × ${track!.ratio}` : name);
                })}>
          <Spin on={busy === 'save'} />Save
        </Button>
      </div>
      <Problem error={error} />
    </div>
  );
}

/** What Wealthfolio's own search offers for a ticker it did not recognize. */
function Suggest({ list, onPick }: { list?: { symbol: string; name?: string }[]; onPick: (symbol: string) => void }) {
  if (!list?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Wealthfolio suggests:</span>
      {list.map((h) => <Button key={h.symbol} size="sm" variant="outline" title={h.name} onClick={() => onPick(h.symbol)}>{h.symbol}</Button>)}
    </div>
  );
}
