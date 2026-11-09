// 3. Accounts: which accounts sync, creating them in Wealthfolio. Connections are refreshed on open, once a day.
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Icons, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@wealthfolio/ui';
import { useCallback, useEffect, useState } from 'react';
import type { Engine } from '../engine/engine';
import { type AccountCfg, jointByMask, type PlaidEnv, planLinks, plural, WF_TYPE } from '../importer';
import { ACTIONS, FlashLabel, host, Problem, ProgressList, Spin, useFlash, useSave, useTask, WithSave } from './common';

const KIND: Record<string, string> = { investment: 'Investment', cash: 'Cash', credit: 'Credit card', unsupported: 'Not supported' };

/** names: bank and card accounts to sync without spending; available: whether Wealthfolio's spending is on at all. */
export type SpendingOff = { names: string[]; available: boolean };

export function Accounts({ engine, env, version, onChange, onSpendingOff }: { engine: Engine; env: PlaidEnv; version: number; onChange: () => void;
  onSpendingOff: (s: SpendingOff) => void }) {
  const [cfg, setCfg] = useState<Record<string, AccountCfg>>({});
  const [spending, setSpending] = useState<Set<string> | null>(null);
  const [wf, setWf] = useState<Awaited<ReturnType<Engine['wealthfolioAccounts']>>>([]);
  const [pushed, setPushed] = useState<Set<string>>(new Set());
  // Creating accounts and the refresh are engine tasks: they finish, and keep their result, on another screen.
  const { task: created, busy, error, start } = useTask(engine, 'accounts');
  const { task: refreshTask } = useTask(engine, 'refresh');
  // Only lines with news: new accounts or a problem. A connection with nothing new is not listed.
  const refresh = (refreshTask?.progress ?? []).filter((p) => p.state === 'error' || p.state === 'warn' || (p.state === 'done' && p.detail !== 'No new accounts'));
  const refreshing = Boolean(refreshTask?.running);
  const { save } = useSave(); // Select all and Change: their result shows in the table
  const [allSaved, flashAll] = useFlash();
  const load = useCallback(async () => {
    await engine.accountsReady(); // forgets accounts deleted in Wealthfolio
    setCfg(await engine.store.accounts(env));
    setSpending(await engine.spendingAccounts());
    setWf(await engine.wealthfolioAccounts());
    setPushed(await engine.pushedAccounts());
    onChange();
  }, [engine, env]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load, version]);
  // New accounts at the institution show up without a button. Errors stay on their line.
  useEffect(() => {
    if (!engine.tasks.refresh?.running) engine.task('refresh', 'refresh', (io) => engine.refreshStale(io.progress)).catch(() => {});
  }, [engine, env]);
  useEffect(() => { if (refreshTask && !refreshTask.running) load(); }, [refreshTask?.running]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (created && !created.running) load(); }, [created?.running]); // eslint-disable-line react-hooks/exhaustive-deps
  const note = created && !created.running && !created.error ? String(created.result) : undefined;

  const joint = jointByMask(cfg);
  // A joint account linked under two owners, synced under both.
  const doubled = (() => {
    const on = new Map<string, string[]>();
    for (const [id, c] of Object.entries(cfg)) {
      if (!joint.has(id) || c.skip) continue;
      const k = [c.institution_id, c.mask, c.plaid_subtype].join('|');
      on.set(k, [...(on.get(k) ?? []), String(c.name)]);
    }
    return [...on.values()].filter((n) => n.length > 1).map((n) => n.join(' and '));
  })();
  const rows = Object.entries(cfg).sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name)));
  const missing = rows.filter(([, c]) => !c.skip && c.kind !== 'unsupported' && !c.wealthfolio_account_id).length;
  const supported = rows.filter(([, c]) => c.kind !== 'unsupported');
  const allOn = supported.length > 0 && supported.every(([, c]) => !c.skip);

  // The same plan Create uses, so what a row shows is what it gets. One Wealthfolio account per row.
  const links = planLinks(cfg, wf);
  const linked = new Set(Object.values(cfg).map((c) => c.wealthfolio_account_id).filter(Boolean));
  const pickedElsewhere = (id: string) => new Set(Object.entries(cfg)
    .filter(([x, c]) => x !== id && !c.skip && c.match && c.match !== 'new').map(([, c]) => c.match));
  const freeFor = (id: string, c: AccountCfg) => wf.filter((a) => a.accountType === WF_TYPE[c.kind] && !linked.has(a.id) && !pickedElsewhere(id).has(a.id));
  // The Wealthfolio account a row is, or will be, linked to.
  const targetOf = (id: string, c: AccountCfg) => c.wealthfolio_account_id || (c.skip || c.kind === 'unsupported' ? null : links[id] ?? null);
  const matchCell = (id: string, c: AccountCfg) => {
    if (c.kind === 'unsupported' || c.skip) return <span className="text-muted-foreground text-sm">—</span>;
    if (c.wealthfolio_account_id) {
      const name = wf.find((a) => a.id === c.wealthfolio_account_id)?.name ?? '—';
      return pushed.has(id) ? (
        <span className="flex items-center gap-1.5 text-sm" title={`Already pushed to ${name}, so the link cannot change.`}>
          <Icons.Lock className="text-muted-foreground h-3 w-3" />{name}
        </span>
      ) : (
        <span className="flex items-center gap-2 text-sm">
          {name}
          <button type="button" className="text-primary text-xs underline underline-offset-2" disabled={!!busy}
                  onClick={() => save(async () => { await engine.unlinkAccount(id); await load(); })}>Change</button>
        </span>
      );
    }
    const free = freeFor(id, c);
    const value = links[id] ?? 'new';
    return (
      <WithSave>
        {(save) => (
          <select value={value} disabled={!!busy} aria-label="Previous account"
                  className="border-input bg-background h-8 max-w-56 rounded-md border px-2 text-sm"
                  onChange={(e) => { const v = e.target.value; save(async () => { await engine.setMatch(id, v); await load(); }); }}>
            <option value="new">New</option>
            {free.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </WithSave>
    );
  };

  // Bank and card accounts to sync that spending does not cover (or cannot be read for).
  const spendingOff = rows.filter(([id, c]) => !c.skip && (c.kind === 'cash' || c.kind === 'credit')
    && !(spending && targetOf(id, c) && spending.has(targetOf(id, c)!))).map(([, c]) => String(c.name));
  const toCreate = rows.filter(([id, c]) => !c.skip && c.kind !== 'unsupported' && !targetOf(id, c)).length;
  // The page asks before the user leaves this step with spending off.
  const offKey = spendingOff.join('\n');
  useEffect(() => { onSpendingOff({ names: spendingOff, available: Boolean(spending?.size) }); }, [offKey, spending?.size]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4 space-y-0">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-lg">Step 3: Accounts to sync</CardTitle>
            <CardDescription>
              Turn on accounts, link an existing account, or create new. Sync stays locked until every selected account exists.
            </CardDescription>
          </div>
          <div className={ACTIONS}>
          <Button variant="outline" className="min-w-32" disabled={!rows.some(([, c]) => c.kind !== 'unsupported') || !!busy}
                  onClick={() => save(async () => { await engine.setSyncAll(!allOn); await load(); flashAll(); })}>
            <FlashLabel on={allSaved} done="Saved">{allOn ? 'Clear all' : 'Select all'}</FlashLabel>
          </Button>
          <Button disabled={!missing || !!busy}
                  onClick={() => start('create', async () => {
                    const n = await engine.createAccounts();
                    host.ctx?.api.query.invalidateQueries(['accounts']);
                    return n ? `${plural(n, 'account')} created in Wealthfolio.` : 'Accounts linked.';
                  })}>
            <Spin on={busy === 'create'} /><Icons.Plus className="h-4 w-4" />
            {toCreate ? `Create ${plural(toCreate, 'Wealthfolio account')}`
              : missing ? `Link ${plural(missing, 'existing account')}` : 'All accounts exist'}
          </Button>
          </div>
        </CardHeader>
        {/* Below the buttons, with the refresh's errors and new accounts. */}
        {(refreshing || refresh.length > 0) && (
          <CardContent className="flex flex-col gap-2">
            {refreshing && <span className="text-muted-foreground flex items-center gap-2 text-sm"><Spin on />Checking for new accounts</span>}
            {refresh.length > 0 && <ProgressList list={refresh} />}
          </CardContent>
        )}
        {doubled.length > 0 && (
          <CardContent>
            <Alert>
              <Icons.AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertTitle>Joint account turned on twice</AlertTitle>
              <AlertDescription>
                {doubled.join('; ')}. Each owner's link shows the same account, so syncing both counts it twice. Turn one off.
              </AlertDescription>
            </Alert>
          </CardContent>
        )}
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="ps-6">Sync</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Previous account</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="pe-6">Spend tracking</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(([id, c]) => (
                <TableRow key={id}>
                  <TableCell className="ps-6">
                    <WithSave>
                      {(save) => (
                        <Switch checked={!c.skip} disabled={c.kind === 'unsupported' || !!busy}
                                onCheckedChange={(on) => save(async () => { await engine.setSync(id, on); await load(); })} />
                      )}
                    </WithSave>
                  </TableCell>
                  <TableCell>
                    {String(c.name)}
                    {(c.joint || joint.has(id)) && <Badge variant="info-subtle" className="ms-2">Joint</Badge>}
                  </TableCell>
                  <TableCell>{KIND[c.kind] ?? c.kind}</TableCell>
                  <TableCell>{matchCell(id, c)}</TableCell>
                  <TableCell>
                    {targetOf(id, c) ? <Badge variant="success-subtle">Yes</Badge> : <Badge variant="warning-subtle">No</Badge>}
                  </TableCell>
                  <TableCell className="pe-6">
                    {!targetOf(id, c) || spending === null || (c.kind !== 'cash' && c.kind !== 'credit')
                      ? <span className="text-muted-foreground text-sm">—</span>
                      : spending.has(targetOf(id, c)!) ? <Badge variant="success-subtle">On</Badge>
                      : <Badge variant="warning-subtle">Off</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {[...Object.values(cfg)].some((c) => c.wealthfolio_account_id && (c.kind === 'cash' || c.kind === 'credit')) && spending && (
        <p className="text-muted-foreground text-sm">Spending Off: turn it on for that account in Wealthfolio → Settings → Spending. An add-on cannot change it.</p>
      )}
      {note && <Alert><Icons.CheckCircle className="h-4 w-4" /><AlertTitle>{note}</AlertTitle></Alert>}
      <Problem error={error} />
    </div>
  );
}
