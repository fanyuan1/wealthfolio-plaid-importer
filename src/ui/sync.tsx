// 4. Sync: dry run, push (fills in categories), ratio proposals. 5. Daily sync.
import { Alert, AlertDescription, AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icons, Input, Label, Progress as Bar, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@wealthfolio/ui';
import { useEffect, useState } from 'react';
import { type AutoRun, DEFAULT_DAILY, nextRun, type SyncView, type Daily as DailyCfg, type Engine, type Proposal, type RunRecord, summary } from '../engine/engine';
import { accountNames, type PlaidEnv, type TodoGroup as Group, todoGroups } from '../importer';
import { ACTIONS, host, Problem, ProgressList, SaveMark, Spin, StateIcon, type Step, SWITCH_ROW, useBusy, useEngine, useSave, useTask } from './common';
import { Matches } from './matches';
import { Securities } from './securities';

const SECURITIES_ID = 'plaid-securities';

export function Sync({ engine, env, onStep }: { engine: Engine; env: PlaidEnv; onStep: (s: Step) => void }) {
  // Everything here lives in the engine, so a dry run or push keeps going, and keeps its progress, on another screen.
  const view = useEngine(engine, (e) => e.view);
  const { task, busy, error, start } = useTask(engine, 'sync');
  const dry = view.dry?.env === env ? view.dry : undefined;
  const secs = dry?.securities ?? [];
  const { stale, result, failed, refused } = view;
  const set = (p: Partial<SyncView>) => engine.setView(p);
  const [moving, setMoving] = useState<[string, Set<string>]>(); // a moved ticker waiting for the delete confirm
  const [attention, setAttention] = useState(0); // securities still to review
  const [last, setLast] = useState<{ time: string; message: string } | null>(null);
  useEffect(() => { engine.store.lastSync(env).then(setLast); }, [engine, env, result]);
  const progress = task?.label === 'dry' ? task.progress : [];
  const pushing = task?.label === 'push' ? task.progress : [];

  const names = accountNames(dry?.cfg ?? {});
  const byType = new Map<string, number>();
  for (const a of dry?.plan.new ?? []) byType.set(a.activityType, (byType.get(a.activityType) ?? 0) + 1);
  const stages = dry ? [dry.plan.new.length, dry.plan.updates.length + dry.plan.voids.length + dry.plan.retype.length, dry.plan.pairs.length, dry.plan.categories.size]
    .filter((n) => n > 0).length : 0;
  const groups = dry ? todoGroups(dry.todo) : [];

  const dryRun = (fresh = false) => start('dry', async (io) => {
    set({ dry: undefined, result: undefined, failed: [] });
    const d = await engine.dryRun(io.log, io.progress, fresh);
    set({ dry: d, stale: false });
  });
  const push = () => start('push', async (io) => {
    const d = dry!;
    const s = await engine.pushAndCategorize(d, io.log, io.progress);
    // What is left (rows Wealthfolio refused) is planned again from the same pull, so the screen keeps its work.
    io.progress({ id: 'push:left', label: 'Plan what is left', state: 'running' });
    const next = await engine.afterPush(d);
    io.progress({ id: 'push:left', label: 'Plan what is left', state: 'done', detail: `${next.plan.new.length} rows left` });
    set({ dry: next, stale: false, failed: s.failures, refused: s.refused,
      result: summary(d.plan, d.fetched, s) + (s.categories ? `. ${s.categories}` : '') });
    host.ctx?.api.query.invalidateQueries(['activities']);
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4 space-y-0">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-lg">Step 4: Pull new data</CardTitle>
            <CardDescription>
              Dry run shows what would change. Push sends exactly that.{' '}
              {last ? `Last push ${new Date(last.time).toLocaleString()}.` : 'Nothing pushed yet.'}
            </CardDescription>
          </div>
          <div className={ACTIONS}>
            <Button variant="outline" disabled={!!busy} onClick={() => dryRun()}>
              <Spin on={busy === 'dry'} /><Icons.RefreshCw className="h-4 w-4" />Dry run
            </Button>
            <Button disabled={!dry || stale || attention > 0 || !!busy} onClick={push}>
              <Spin on={busy === 'push'} /><Icons.Upload className="h-4 w-4" />Push to Wealthfolio
            </Button>
          </div>
        </CardHeader>
        {(progress.length > 0 || dry) && (
          <CardContent className="flex flex-col gap-4">
            <ProgressList list={progress} />
            {dry?.fetched.pulledAt && !busy && (
              <span className="text-muted-foreground text-xs">
                Plaid data from {new Date(dry.fetched.pulledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Dry run reuses it for 15 minutes.{' '}
                <button type="button" className="text-primary underline underline-offset-2" onClick={() => dryRun(true)}>Pull fresh from Plaid</button>
              </span>
            )}
            {dry && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Push would make:</span>
                <Badge variant="info-subtle">{dry.plan.new.length} new</Badge>
                <Badge variant="secondary">{dry.plan.updates.length} updated</Badge>
                <Badge variant="secondary">{dry.plan.voids.length} removed</Badge>
                <Badge variant="secondary">{dry.plan.pairs.length} transfers</Badge>
                <Badge variant="secondary">{dry.plan.categories.size} categorized</Badge>
                {[...byType].map(([t, n]) => <Badge key={t} variant="outline">{t} {n}</Badge>)}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {dry && dry.fetched.skipped.length > 0 && (
        <Alert variant="destructive">
          <Icons.AlertCircle className="h-4 w-4" />
          <AlertTitle>Reconnect needed</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>{dry.fetched.skipped.join(', ')}. These were skipped. The others can be pushed.</span>
            <div><Button size="sm" variant="outline" onClick={() => onStep('connections')}>Go to Connections</Button></div>
          </AlertDescription>
        </Alert>
      )}
      {dry && dry.plan.moved.size > 0 && (
        <Alert variant="destructive">
          <Icons.AlertTriangle className="h-4 w-4" />
          <AlertTitle>Do not push yet</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>Pushed activities now map to another ticker, to cash or to Leave out. Delete them; the next push imports them again as set now.</span>
            <div className="flex flex-wrap gap-2">
              {[...dry.plan.moved].map(([sym, accts]) => (
                <Button key={sym} size="sm" variant="outline" disabled={!!busy} onClick={() => setMoving([sym, accts])}>
                  Delete pushed {sym} activities
                </Button>
              ))}
            </div>
          </AlertDescription>
        </Alert>
      )}
      {dry && dry.rebases.map((r) => (
        <RatioProposal key={r.sid} engine={engine} p={r} onDone={() => set({ stale: true })} />
      ))}
      {result && <Alert><Icons.CheckCircle className="h-4 w-4 text-green-600" /><AlertTitle>Pushed</AlertTitle><AlertDescription>{result}</AlertDescription></Alert>}
      <Problem error={error} />
      {stale && (
        <Alert>
          <AlertTitle>Securities changed</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>When you finish, update the preview. Push is off until then.</span>
            <div>
              <Button size="sm" disabled={!dry || !!busy}
                      onClick={() => start('replan', async () => { const d = await engine.replan(dry!); set({ dry: d, stale: false }); })}>
                <Spin on={busy === 'replan'} /><Icons.RefreshCw className="h-3 w-3" />Update preview
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {attention > 0 && <Alert><AlertTitle>Review {attention} securities before you push</AlertTitle><AlertDescription>Push stays off until Needs attention is empty.</AlertDescription></Alert>}
      {secs.length > 0 && (
        <div id={SECURITIES_ID}>
          <Securities engine={engine} list={secs} refused={refused} onAttention={setAttention}
                      onSaved={(sid, override, label) => {
                        const d = engine.view.dry!;
                        set({ stale: true, dry: { ...d, securities: d.securities.map((s) => (s.sid === sid ? { ...s, override, pending: label } : s)) } });
                      }} />
        </div>
      )}
      {dry && dry.adoptions.length > 0 && (attention > 0 || stale
        ? <p className="text-muted-foreground text-sm">Map the securities above first. Then update the preview and check {dry.adoptions.length} rows for duplicates.</p>
        : <Matches list={dry.adoptions} names={names} onChange={(adoptions) => set({ dry: { ...dry, adoptions } })} />)}
      {groups.length > 0 && <TodoCards groups={groups} />}

      <Dialog open={busy === 'push'} disablePointerDismissal>
        <DialogContent showCloseButton={false} className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Spin on />Pushing to Wealthfolio…</DialogTitle>
            <DialogDescription>Keep Wealthfolio open until it finishes. Closing it now can stop the push half way.</DialogDescription>
          </DialogHeader>
          <Bar value={stages ? Math.min(100, (100 * pushing.filter((p) => p.state !== 'running').length) / stages) : null} />
          <ProgressList list={pushing} />
        </DialogContent>
      </Dialog>
      <Dialog open={failed.length > 0} onOpenChange={(o) => { if (!o) set({ failed: [] }); }}>
        <DialogContent className="max-h-[80dvh] max-w-3xl overflow-auto">
          <DialogHeader>
            <DialogTitle className="text-destructive">{failed.length === 1 ? '1 row was' : `${failed.length} rows were`} not saved</DialogTitle>
            <DialogDescription>Wealthfolio rejected these rows, so they are missing. They stay in the preview: fix the cause below, then Update preview and push again.</DialogDescription>
          </DialogHeader>
          <FailedRows list={failed} />
          <DialogFooter><Button onClick={() => set({ failed: [] })}>OK</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!moving} onOpenChange={(o) => { if (!o) setMoving(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete pushed {moving?.[0]} activities?</AlertDialogTitle>
            <AlertDialogDescription>
              Wealthfolio cannot move an activity to another ticker. The addon deletes the {moving?.[0]} activities it pushed. Rows you
              had before or edited stay. Then click Dry run: the next push imports them as the security is set now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              const [sym, accts] = moving!;
              start('retrack', async () => {
                const n = await engine.retrack(sym, accts);
                set({ dry: undefined, result: `Deleted ${n} ${sym} activities. Click Dry run.` });
                host.ctx?.api.query.invalidateQueries(['activities']);
              });
            }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const SHOWN = 5;

function TodoCards({ groups }: { groups: Group[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">To do after the push</CardTitle>
        <CardDescription>The push does not need these, but your numbers may be off until you fix them.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {groups.map((g) => <TodoCard key={g.heading} g={g} />)}
      </CardContent>
    </Card>
  );
}

function TodoCard({ g }: { g: Group }) {
  const [all, setAll] = useState(false);
  const inSecurities = /Sync → Securities/.test(g.text);
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        {g.warning ? <Icons.AlertTriangle className="h-4 w-4 text-amber-600" /> : <Icons.Info className="text-muted-foreground h-4 w-4" />}
        <span className="font-medium">{g.heading}</span>
        {g.count > 0 && <Badge variant="secondary">{g.count}</Badge>}
        <span className="ms-auto">
          {inSecurities
            ? <Button size="sm" variant="outline" onClick={() => document.getElementById(SECURITIES_ID)?.scrollIntoView({ behavior: 'smooth' })}>Go to Securities</Button>
            : !g.warning && <span className="text-muted-foreground text-xs">Fix in Wealthfolio</span>}
        </span>
      </div>
      <p className="text-muted-foreground text-sm">{g.text}</p>
      {g.items.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs">
          {(all ? g.items : g.items.slice(0, SHOWN)).map((x, i) => <li key={i} className="break-words">{x}</li>)}
          {g.items.length > SHOWN && (
            <li><button type="button" className="text-primary underline underline-offset-2" onClick={() => setAll(!all)}>
              {all ? 'Show less' : `Show ${g.items.length - SHOWN} more`}
            </button></li>
          )}
        </ul>
      )}
    </div>
  );
}

/** push.ts writes each failure as "date type symbol amount (plaid:id) — reason". */
function FailedRows({ list }: { list: string[] }) {
  const groups = new Map<string, string[][]>();
  for (const f of list) {
    const m = /^(\S+) (\S+) (\S*) (\S*) \(plaid:[^)]*\)(?: — (.*))?$/.exec(f);
    const why = m?.[5] || 'No reason given';
    groups.set(why, [...(groups.get(why) ?? []), m ? [m[1], m[2], m[3], m[4]] : [f, '', '', '']]);
  }
  return (
    <div className="flex flex-col gap-4">
      {[...groups].map(([why, rows]) => (
        <div key={why} className="flex flex-col gap-2">
          <div className="text-sm font-medium">{why} <Badge variant="secondary">{rows.length}</Badge></div>
          <p className="text-muted-foreground text-xs">
            {/symbol|asset|quote|ticker|market/i.test(why)
              ? 'Usually a ticker Wealthfolio cannot price. Set it under Securities in this step.'
              : 'Check these rows against your statements, then run the dry run and push again.'}
          </p>
          <Table>
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Symbol</TableHead><TableHead className="text-end">Amount</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.slice(0, 50).map((r, i) => (
                <TableRow key={i}><TableCell>{r[0]}</TableCell><TableCell>{r[1]}</TableCell><TableCell>{r[2] || '—'}</TableCell><TableCell className="text-end">{r[3] || '—'}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
          {rows.length > 50 && <span className="text-muted-foreground text-xs">… and {rows.length - 50} more.</span>}
        </div>
      ))}
    </div>
  );
}

const STATUS: Record<RunRecord['status'], [string, 'success-subtle' | 'warning-subtle' | 'destructive']> = {
  ok: ['Succeeded', 'success-subtle'], stopped: ['Needs you', 'warning-subtle'], failed: ['Failed', 'destructive'],
};

export function Daily({ engine, env, onStep }: { engine: Engine; env: PlaidEnv; onStep: (s: Step) => void }) {
  const [daily, setDaily] = useState<DailyCfg>(DEFAULT_DAILY);
  const [rec, setRec] = useState<AutoRun>({});
  const [next, setNext] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  // The task is the engine's: a run started here or by the timer shows its progress after leaving and coming back.
  const { task, busy, error } = useTask(engine, 'daily');
  const engineBusy = useEngine(engine, (e) => e.busy); // the daily sync waits for any other task
  // The switch and the time each show their own save.
  const onSave = useSave(), timeSave = useSave();
  useEffect(() => {
    let live = true;
    Promise.all([engine.store.daily(), engine.store.autoRun(env)]).then(([d, r]) => {
      if (!live) return;
      setDaily(d);
      setRec(r);
      setNext(nextRun(d, r));
    });
    return () => { live = false; };
  }, [engine, env, tick, busy]);
  // The timer may run a sync while this tab is open in another window: refresh now and then.
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 60_000); return () => clearInterval(t); }, []);
  const change = (d: DailyCfg, via: ReturnType<typeof useSave>) => {
    setDaily(d);
    via.save(async () => {
      await engine.store.saveDaily(d);
      setTick((n) => n + 1);
    });
  };
  const latest = rec.runs?.[0];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Step 5: Daily sync</CardTitle>
          <CardDescription>
            Pulls and pushes once a day while Wealthfolio is open, with no questions. It stops if something needs you. The switch does not
            sync to paired devices, so they do not push the same rows twice.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className={SWITCH_ROW}>
              <SaveMark status={onSave.status}>
                <Switch id="daily" checked={daily.on} onCheckedChange={(on) => change({ ...daily, on }, onSave)} />
              </SaveMark>
              <Label htmlFor="daily">{daily.on ? 'On' : 'Off'}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="daily-time" className={daily.on ? '' : 'text-muted-foreground'}>Run after</Label>
              <SaveMark status={timeSave.status}>
                <Input id="daily-time" type="time" className="h-9 w-36" value={daily.time} disabled={!daily.on}
                       onChange={(e) => e.target.value && change({ ...daily, time: e.target.value }, timeSave)} />
              </SaveMark>
            </div>
            <Button variant="outline" className="ms-auto" disabled={engineBusy}
                    onClick={() => engine.runDaily().then(() => host.ctx?.api.query.invalidateQueries(['activities']), () => {})}>
              <Spin on={!!busy} /><Icons.RefreshCw className="h-4 w-4" />Run now
            </Button>
          </div>
          <div className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>Next run: {next ? next.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : daily.on ? '—' : 'off'}</span>
            <span>Last run: {latest ? new Date(latest.time).toLocaleString() : 'never'}</span>
          </div>
          {busy && <p className="text-muted-foreground flex items-center gap-2 text-sm"><Spin on />Daily sync running… You can leave this screen.</p>}
          {busy && <ProgressList list={task?.progress ?? []} />}
          <Problem error={error} />
        </CardContent>
      </Card>
      {latest && <LastRun r={latest} onStep={onStep} />}
      {rec.runs && rec.runs.length > 1 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Recent runs</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                {rec.runs.map((r) => (
                  <TableRow key={r.time}>
                    <TableCell className="whitespace-nowrap ps-6 text-sm">{new Date(r.time).toLocaleString()}</TableCell>
                    <TableCell className="w-28"><Badge variant={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge></TableCell>
                    <TableCell className="text-muted-foreground min-w-56 pe-6 text-sm">{r.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const RUN_STATE = { ok: 'done', stopped: 'warn', failed: 'error' } as const;

function LastRun({ r, onStep }: { r: RunRecord; onStep: (s: Step) => void }) {
  const [label, tone] = STATUS[r.status];
  const t = r.totals;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3 space-y-0">
        <StateIcon state={RUN_STATE[r.status]} size="h-5 w-5" />
        <CardTitle className="text-base">Last run</CardTitle>
        <Badge variant={tone}>{label}</Badge>
        <span className="text-muted-foreground text-sm">{new Date(r.time).toLocaleString()}</span>
        {r.goto && (
          <Button size="sm" variant="outline" className="ms-auto" onClick={() => onStep(r.goto!)}>
            Go to {r.goto === 'connections' ? 'Connections' : 'Sync'}<Icons.ArrowRight className="h-3 w-3" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">{r.message}</p>
        {t && (
          <div className="flex flex-wrap gap-2">
            <Badge variant="info-subtle">{t.new} new</Badge>
            <Badge variant="secondary">{t.updated} updated</Badge>
            <Badge variant="secondary">{t.removed} removed</Badge>
            <Badge variant="secondary">{t.categorized} categorized</Badge>
            {t.failed > 0 && <Badge variant="destructive">{t.failed} not saved</Badge>}
          </div>
        )}
        {r.accounts && r.accounts.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Account</TableHead><TableHead className="text-end">New</TableHead><TableHead className="text-end">Updated</TableHead><TableHead className="text-end">Removed</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {r.accounts.map((a) => (
                <TableRow key={a.name}><TableCell>{a.name}</TableCell><TableCell className="text-end">{a.new}</TableCell><TableCell className="text-end">{a.updated}</TableCell><TableCell className="text-end">{a.removed}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {t && !r.accounts?.length && <span className="text-muted-foreground text-sm">Nothing new at Plaid.</span>}
      </CardContent>
    </Card>
  );
}

function RatioProposal({ engine, p, onDone }: { engine: Engine; p: Proposal; onDone: () => void }) {
  const { busy, error, run } = useBusy();
  const pct = p.change === null ? '' : ` (${p.change >= 0 ? '+' : ''}${(p.change * 100).toFixed(2)}%)`;
  return (
    <Alert>
      <AlertTitle>Update the exchange ratio of {p.name}?</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        {p.next ? (
          <span>
            {p.price} on {p.day} vs {p.old.symbol} {p.next.close}: ratio {p.old.ratio} → {p.next.ratio}{pct}.
          </span>
        ) : (
          <span>
            {p.price} on {p.day}; no {p.old.symbol} close for that day yet. Set it in Securities, or wait.
          </span>
        )}
        {p.next && (
          <div className="flex gap-2">
            <Button size="sm" disabled={!!busy}
                    onClick={() => run('ratio', async () => { await engine.setSecurity(p.sid, p.name, { mode: 'track', track: p.next! }); onDone(); })}>
              <Spin on={busy === 'ratio'} />Use the new ratio
            </Button>
          </div>
        )}
        <Problem error={error} />
      </AlertDescription>
    </Alert>
  );
}
