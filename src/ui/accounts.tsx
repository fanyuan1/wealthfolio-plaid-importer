import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Icons, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@wealthfolio/ui';
import { useCallback, useEffect, useState } from 'react';
import type { Engine, Task } from '../engine/engine';
import { type AccountCfg, jointByMask, type PlaidEnv, planLinks, plural, WF_TYPE } from '../importer';
import { ACTIONS, FlashLabel, host, Problem, ProgressList, Spin, useBusy, useFlash, useSave, useTask, WithSave } from './common';

const KIND: Record<string, string> = { investment: 'Investment', cash: 'Cash', credit: 'Credit card', unsupported: 'Not supported' };

export type SpendingOff = { names: string[]; available: boolean };

type WfAccounts = Awaited<ReturnType<Engine['wealthfolioAccounts']>>;

function useAccountData(engine: Engine, env: PlaidEnv, version: number, onChange: () => void) {
  const [cfg, setCfg] = useState<Record<string, AccountCfg>>({});
  const [spending, setSpending] = useState<Set<string> | null>(null);
  const [wf, setWf] = useState<WfAccounts>([]);
  const [pushed, setPushed] = useState<Set<string>>(new Set());
  const { error: loadError, fail } = useBusy();
  const load = useCallback(async () => {
    await engine.accountsReady();
    setCfg(await engine.store.accounts(env));
    setSpending(await engine.spendingAccounts());
    setWf(await engine.wealthfolioAccounts());
    setPushed(await engine.pushedAccounts());
    onChange();
  }, [engine, env, onChange]);
  const reload = useCallback(() => { load().catch((e: unknown) => fail('load', e)); }, [load, fail]);
  useEffect(() => { reload(); }, [reload, version]);
  return { cfg, spending, wf, pushed, load, reload, loadError };
}

function useReloadWhenDone(task: Task | undefined, reload: () => void) {
  const done = task ? !task.running : false;
  useEffect(() => { if (done) reload(); }, [done, reload]);
}

function doubledJoint(cfg: Record<string, AccountCfg>, joint: Set<string>): string[] {
  const on = new Map<string, string[]>();
  for (const [id, c] of Object.entries(cfg)) {
    if (!joint.has(id) || c.skip) continue;
    const k = [c.institution_id, c.mask, c.plaid_subtype].join('|');
    on.set(k, [...(on.get(k) ?? []), String(c.name)]);
  }
  return [...on.values()].filter((n) => n.length > 1).map((n) => n.join(' and '));
}

interface AccountView {
  engine: Engine;
  cfg: Record<string, AccountCfg>;
  wf: WfAccounts;
  pushed: Set<string>;
  links: ReturnType<typeof planLinks>;
  spending: Set<string> | null;
  joint: Set<string>;
  busy: string | undefined;
  load: () => Promise<void>;
}

const targetOf = (v: Pick<AccountView, 'links'>, id: string, c: AccountCfg) =>
  c.wealthfolio_account_id || (c.skip || c.kind === 'unsupported' ? null : v.links[id] ?? null);

export function Accounts({ engine, env, version, onChange, onSpendingOff }: { engine: Engine; env: PlaidEnv; version: number; onChange: () => void;
  onSpendingOff: (s: SpendingOff) => void }) {
  const { cfg, spending, wf, pushed, load, reload, loadError } = useAccountData(engine, env, version, onChange);
  const { task: created, busy, error, start } = useTask(engine, 'accounts');
  const { task: refreshTask } = useTask(engine, 'refresh');
  const refresh = (refreshTask?.progress ?? []).filter((p) => p.state === 'error' || p.state === 'warn' || (p.state === 'done' && p.detail !== 'No new accounts'));
  const refreshing = Boolean(refreshTask?.running);
  useEffect(() => {
    if (!engine.tasks.refresh?.running) engine.task('refresh', 'refresh', (io) => engine.refreshStale(io.progress)).catch(() => {});
  }, [engine, env]);
  useReloadWhenDone(refreshTask, reload);
  useReloadWhenDone(created, reload);
  const note = created && !created.running && !created.error ? String(created.result) : undefined;

  const joint = jointByMask(cfg);
  const doubled = doubledJoint(cfg, joint);
  const rows = Object.entries(cfg).sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name)));
  const view: AccountView = { engine, cfg, wf, pushed, links: planLinks(cfg, wf), spending, joint, busy, load };

  const offKey = rows.filter(([id, c]) => !c.skip && (c.kind === 'cash' || c.kind === 'credit')
    && !(spending && spending.has(targetOf(view, id, c) ?? ''))).map(([, c]) => String(c.name)).join('\n');
  const available = Boolean(spending?.size);
  useEffect(() => { onSpendingOff({ names: offKey ? offKey.split('\n') : [], available }); }, [offKey, available, onSpendingOff]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <AccountsHeader view={view} rows={rows} start={start} />
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
          <AccountsTable view={view} rows={rows} />
        </CardContent>
      </Card>
      {[...Object.values(cfg)].some((c) => c.wealthfolio_account_id && (c.kind === 'cash' || c.kind === 'credit')) && spending && (
        <p className="text-muted-foreground text-sm">Spending Off: turn it on for that account in Wealthfolio → Settings → Spending. An add-on cannot change it.</p>
      )}
      {note && <Alert><Icons.CheckCircle className="h-4 w-4" /><AlertTitle>{note}</AlertTitle></Alert>}
      <Problem error={error ?? loadError} />
    </div>
  );
}

type Rows = [string, AccountCfg][];

function AccountsHeader({ view, rows, start }: { view: AccountView; rows: Rows; start: ReturnType<typeof useTask>['start'] }) {
  const { engine, busy, load } = view;
  const { save } = useSave();
  const [allSaved, flashAll] = useFlash();
  const missing = rows.filter(([, c]) => !c.skip && c.kind !== 'unsupported' && !c.wealthfolio_account_id).length;
  const supported = rows.filter(([, c]) => c.kind !== 'unsupported');
  const allOn = supported.length > 0 && supported.every(([, c]) => !c.skip);
  const toCreate = rows.filter(([id, c]) => !c.skip && c.kind !== 'unsupported' && !targetOf(view, id, c)).length;
  return (
    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4 space-y-0">
      <div className="flex flex-col gap-1.5">
        <CardTitle className="text-lg">Step 3: Accounts to sync</CardTitle>
        <CardDescription>
          Turn on accounts, link an existing account, or create new. Sync stays locked until every selected account exists.
        </CardDescription>
      </div>
      <div className={ACTIONS}>
      <Button variant="outline" className="min-w-32" disabled={!rows.some(([, c]) => c.kind !== 'unsupported') || Boolean(busy)}
              onClick={() => void save(async () => { await engine.setSyncAll(!allOn); await load(); flashAll(); })}>
        <FlashLabel on={allSaved} done="Saved">{allOn ? 'Clear all' : 'Select all'}</FlashLabel>
      </Button>
      <Button disabled={!missing || Boolean(busy)}
              onClick={() => void start('create', async () => {
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
  );
}

function AccountsTable({ view, rows }: { view: AccountView; rows: Rows }) {
  return (
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
        {rows.map(([id, c]) => <AccountRow key={id} view={view} id={id} c={c} />)}
      </TableBody>
    </Table>
  );
}

function AccountRow({ view, id, c }: { view: AccountView; id: string; c: AccountCfg }) {
  const { engine, busy, load, joint, spending } = view;
  const target = targetOf(view, id, c);
  return (
    <TableRow>
      <TableCell className="ps-6">
        <WithSave>
          {(save) => (
            <Switch checked={!c.skip} disabled={c.kind === 'unsupported' || Boolean(busy)}
                    onCheckedChange={(on) => save(async () => { await engine.setSync(id, on); await load(); })} />
          )}
        </WithSave>
      </TableCell>
      <TableCell>
        {String(c.name)}
        {(c.joint || joint.has(id)) && <Badge variant="info-subtle" className="ms-2">Joint</Badge>}
      </TableCell>
      <TableCell>{KIND[c.kind] ?? c.kind}</TableCell>
      <TableCell><MatchCell view={view} id={id} c={c} /></TableCell>
      <TableCell>
        {target ? <Badge variant="success-subtle">Yes</Badge> : <Badge variant="warning-subtle">No</Badge>}
      </TableCell>
      <TableCell className="pe-6">
        {!target || spending === null || (c.kind !== 'cash' && c.kind !== 'credit')
          ? <span className="text-muted-foreground text-sm">—</span>
          : spending.has(target) ? <Badge variant="success-subtle">On</Badge>
          : <Badge variant="warning-subtle">Off</Badge>}
      </TableCell>
    </TableRow>
  );
}

function MatchCell({ view, id, c }: { view: AccountView; id: string; c: AccountCfg }) {
  const { engine, cfg, wf, pushed, links, busy, load } = view;
  const { save } = useSave();
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
        <button type="button" className="text-primary text-xs underline underline-offset-2" disabled={Boolean(busy)}
                onClick={() => void save(async () => { await engine.unlinkAccount(id); await load(); })}>Change</button>
      </span>
    );
  }
  const linked = new Set(Object.values(cfg).map((x) => x.wealthfolio_account_id).filter(Boolean));
  const pickedElsewhere = new Set(Object.entries(cfg)
    .filter(([x, o]) => x !== id && !o.skip && o.match && o.match !== 'new').map(([, o]) => o.match));
  const free = wf.filter((a) => a.accountType === WF_TYPE[c.kind] && !linked.has(a.id) && !pickedElsewhere.has(a.id));
  return (
    <WithSave>
      {(withSave) => (
        <select value={links[id] ?? 'new'} disabled={Boolean(busy)} aria-label="Previous account"
                className="border-input bg-background h-8 max-w-56 rounded-md border px-2 text-sm"
                onChange={(e) => { const v = e.target.value; withSave(async () => { await engine.setMatch(id, v); await load(); }); }}>
          <option value="new">New</option>
          {free.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      )}
    </WithSave>
  );
}
