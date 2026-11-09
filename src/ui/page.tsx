// The page: the steps as a stepper.
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icons, Page, PageContent, PageHeader, Tabs, TabsContent, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@wealthfolio/ui';
import { useEffect, useState } from 'react';
import { Engine } from '../engine/engine';
import type { PlaidEnv } from '../importer';
import { host, type Step, TITLE } from './common';
import { Setup } from './setup';
import { Connections } from './connections';
import { Accounts, type SpendingOff } from './accounts';
import { Daily, Sync } from './sync';
import { Backup } from './backup';

export function PlaidImporter({ ctx }: { ctx: AddonContext }) {
  const [engine] = useState(() => (host.engine ??= new Engine(ctx.api)));
  useEffect(() => {
    engine.pageOpen++;
    return () => { engine.pageOpen--; };
  }, [engine]);
  const [env, setEnv] = useState<PlaidEnv>();
  const [version, setVersion] = useState(0);
  const [step, setStep] = useState<Step>();
  const [tick, setTick] = useState(0);
  const [ready, setReady] = useState(false); // accounts chosen and all created in Wealthfolio
  const [done, setDone] = useState<Partial<Record<Step, boolean>>>({});
  const [spendingOff, setSpendingOff] = useState<SpendingOff>({ names: [], available: true });
  const [leaving, setLeaving] = useState<Step>(); // the step the user tried to open while spending is off
  useEffect(() => { engine.accountsReady().then(setReady); }, [engine, step, version, tick]);
  useEffect(() => {
    (async () => {
      const s = await engine.store.settings();
      const k = await engine.store.keys(s.env);
      setDone({ setup: Boolean(k.clientId && k.secret), connections: Object.keys(await engine.store.items(s.env)).length > 0,
        accounts: ready, sync: Boolean(await engine.store.lastSync(s.env)), daily: (await engine.store.daily()).on });
    })();
  }, [engine, env, step, version, tick, ready]);
  useEffect(() => { if (!ready && (step === 'sync' || step === 'daily')) setStep('accounts'); }, [ready, step]);
  useEffect(() => {
    (async () => {
      setEnv((await engine.store.settings()).env);
      const { env } = await engine.store.settings();
      setStep((await engine.store.lastSync(env)) ? 'sync' : 'setup'); // Sync once a push has worked
    })();
  }, [engine]);
  if (!env || !step) return null;
  // Leaving Accounts with spending off for a synced bank or card account asks first (D42).
  const go = (to: Step) => {
    if (step === 'accounts' && to !== 'accounts' && spendingOff.names.length) setLeaving(to);
    else setStep(to);
  };
  const changeEnv = async (e: PlaidEnv) => {
    await engine.store.saveSettings({ ...(await engine.store.settings()), env: e });
    setEnv(e);
  };

  return (
    <Page>
      <PageHeader heading={env === 'sandbox' ? `${TITLE} [Sandbox]` : TITLE}
                  text="Bring bank, card and brokerage data from Plaid into Wealthfolio." />
      <PageContent>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <Tabs value={step} onValueChange={(v) => go(v as Step)}>
            <div className="py-2">
              <Stepper step={step} done={done} locked={ready ? {} : { sync: LOCKED, daily: LOCKED }} onStep={go} />
            </div>
            <TabsContent value="setup"><Setup engine={engine} env={env} onEnv={changeEnv} /></TabsContent>
            <TabsContent value="connections">
              <Connections engine={engine} env={env} onChange={() => setVersion((v) => v + 1)} onStep={go} />
            </TabsContent>
            <TabsContent value="accounts">
              <Accounts engine={engine} env={env} version={version} onChange={() => setTick((t) => t + 1)} onSpendingOff={setSpendingOff} />
            </TabsContent>
            <TabsContent value="sync"><Sync engine={engine} env={env} onStep={go} /></TabsContent>
            <TabsContent value="daily"><Daily engine={engine} env={env} onStep={go} /></TabsContent>
            <TabsContent value="backup">
              <Backup engine={engine} env={env} ready={ready} onChange={() => setVersion((v) => v + 1)} />
            </TabsContent>
          </Tabs>
          <Dialog open={!!leaving} onOpenChange={(o) => { if (!o) setLeaving(undefined); }}>
            <DialogContent>
              <DialogHeader>
                <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/15">
                  <Icons.AlertTriangle className="h-5 w-5 text-amber-500" />
                </div>
                <DialogTitle>Turn on spending first</DialogTitle>
                <DialogDescription>
                  {spendingOff.names.length} bank or card account{spendingOff.names.length === 1 ? ' has' : 's have'} spending{' '}
                  {spendingOff.available ? 'off' : 'not available'}. Without it, their rows are pushed with no spending category.
                </DialogDescription>
              </DialogHeader>
              <div className="bg-muted/50 rounded-md p-3 text-sm">
                Turn it on in <span className="font-medium">Wealthfolio → Settings → Spending</span>. The Spend tracking column shows which accounts.
                Categories are filled in on a later push once it is on.
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setLeaving(undefined)}>Stay here</Button>
                <Button onClick={() => { setStep(leaving); setLeaving(undefined); }}>Continue anyway</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </PageContent>
    </Page>
  );
}

const LOCKED = 'Link every selected account in step 3 first.';
const STEPS: [Step, string][] = [['setup', 'Setup'], ['connections', 'Connections'], ['accounts', 'Accounts'], ['sync', 'Sync'],
  ['daily', 'Daily sync'], ['backup', 'Backup']];

function Stepper({ step, done, locked, onStep }: { step: Step; done: Partial<Record<Step, boolean>>; locked: Partial<Record<Step, string>>;
  onStep: (s: Step) => void }) {
  return (
    <TooltipProvider>
      <ol className="flex flex-wrap items-center gap-1">
        {STEPS.map(([id, label], i) => {
          const lock = locked[id];
          const here = id === step;
          const mark = lock ? <Icons.Lock className="h-3 w-3" /> : done[id] && !here ? <Icons.Check className="h-3 w-3" /> : i + 1;
          const btn = (
            <button type="button" disabled={Boolean(lock)} onClick={() => onStep(id)} aria-current={here ? 'step' : undefined}
                    className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      here ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                here ? 'bg-primary-foreground/20' : done[id] && !lock ? 'bg-green-600 text-white' : 'bg-muted text-muted-foreground'}`}>{mark}</span>
              {label}
            </button>
          );
          return (
            <li key={id} className="flex items-center gap-1">
              {i > 0 && <span className="bg-border h-px w-3" aria-hidden />}
              {lock ? (
                <Tooltip>
                  <TooltipTrigger render={<span />}>{btn}</TooltipTrigger>
                  <TooltipContent>{lock}</TooltipContent>
                </Tooltip>
              ) : btn}
            </li>
          );
        })}
      </ol>
    </TooltipProvider>
  );
}

export const AddonRoute = () => (
  <QueryClientProvider client={host.ctx!.api.query.getClient() as QueryClient}>
    <PlaidImporter ctx={host.ctx!} />
  </QueryClientProvider>
);
