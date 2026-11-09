// 1. Setup: Plaid environment and keys.
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Switch } from '@wealthfolio/ui';
import { useEffect, useState } from 'react';
import type { Engine } from '../engine/engine';
import type { PlaidEnv } from '../importer';
import { CopyLink, FlashLabel, KEYS_URL, Problem, Spin, SWITCH_ROW, useBusy, useFlash } from './common';

export function Setup({ engine, env, onEnv }: { engine: Engine; env: PlaidEnv; onEnv: (e: PlaidEnv) => void }) {
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [have, setHave] = useState(false);
  const [ok, flashOk] = useFlash(); // Plaid accepted the saved keys
  const { busy, error, run } = useBusy();

  useEffect(() => {
    engine.store.keys(env).then((k) => {
      setClientId(k.clientId ?? '');
      setHave(Boolean(k.clientId && k.secret));
    });
  }, [engine, env]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Step 1: Plaid keys</CardTitle>
          <div className={`${SWITCH_ROW} pt-1`}>
            <Switch id="env" checked={env === 'production'} onCheckedChange={(on) => onEnv(on ? 'production' : 'sandbox')} />
            <Label htmlFor="env">{env === 'production' ? 'Production: real accounts' : 'Sandbox: test banks'}</Label>
          </div>
          <CardDescription>Keep Sandbox in its own Wealthfolio profile.</CardDescription>
        </CardHeader>
        <CardContent className="flex max-w-xl flex-col gap-4">
          <span className="text-muted-foreground text-sm">Copy your Client ID and {env === 'production' ? 'Production' : 'Sandbox'} secret from Plaid.</span>
          <CopyLink url={KEYS_URL} hint={false} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="cid">Client ID</Label>
            <Input id="cid" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sec">{env === 'production' ? 'Production' : 'Sandbox'} secret</Label>
            <Input id="sec" type="password" autoComplete="off" value={secret} placeholder={have ? 'Saved. Type to replace it.' : ''}
                   onChange={(e) => setSecret(e.target.value)} />
          </div>
          <div>
            <Button className="min-w-32" disabled={!ok && (!clientId || !secret || !!busy)}
                    onClick={() => !ok && run('save keys', async () => {
                      await engine.saveKeys(env, clientId, secret);
                      setSecret('');
                      setHave(true);
                      await engine.checkKeys();
                      flashOk();
                    })}>
              <Spin on={!!busy} /><FlashLabel on={ok} done="Keys work">Save keys</FlashLabel>
            </Button>
          </div>
        </CardContent>
      </Card>
      <Problem error={error} />
    </div>
  );
}
