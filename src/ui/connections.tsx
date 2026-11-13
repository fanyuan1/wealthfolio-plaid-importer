// 2. Connections: Plaid Hosted Link, reconnect, initials, one existing access token.
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Icons, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@wealthfolio/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Engine, LinkCheck } from '../engine/engine';
import type { ItemMeta } from '../engine/store';
import { type PlaidEnv, plural } from '../importer';
import { ago, CopyLink, FlashLabel, msg, Problem, SaveMark, Spin, type Step, useBusy, useFlash, useSave } from './common';

const POLL_MS = 3000;
const LINK_MS = 30 * 60_000; // stop asking Plaid after this

type Pending = NonNullable<Engine['pendingLink']>;

export function Connections({ engine, env, onChange, onStep }: { engine: Engine; env: PlaidEnv; onChange: () => void; onStep: (s: Step) => void }) {
  const [items, setItems] = useState<Record<string, ItemMeta>>({});
  const [owner, setOwner] = useState('');
  const [link, setLinkState] = useState<Pending | undefined>(engine.pendingLink);
  const [linked, setLinkedState] = useState(engine.lastLinked);
  const setLinked = (l?: typeof linked) => { engine.lastLinked = l; setLinkedState(l); };
  const [added, flashAdded] = useFlash();
  const [tokOwner, setTokOwner] = useState('');
  const [token, setToken] = useState('');
  const [removing, setRemoving] = useState<string>();
  const { busy, error, run } = useBusy();
  const load = useCallback(() => engine.store.items(env).then(setItems), [engine, env]);
  useEffect(() => { load(); }, [load]);
  const setLink = (l?: Pending) => { engine.pendingLink = l; setLinkState(l); };

  const done = async () => {
    await load();
    onChange();
  };
  const start = (p: () => Promise<{ url: string; linkToken: string }>, o: string, itemId?: string) =>
    run(itemId ? 'reconnect' : 'connect', async () => {
      setLinked(undefined);
      setLink({ ...(await p()), owner: o, itemId, started: Date.now() });
    });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Step 2: Connect an institution</CardTitle>
          <CardDescription>Type the owner's initials, click Connect, and log in. Each connection counts toward your Plaid plan.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!link && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="owner">Initials</Label>
                <Input id="owner" className="w-28" maxLength={4} value={owner} onChange={(e) => setOwner(e.target.value.toUpperCase())} />
              </div>
              <Button disabled={owner.length < 1 || !!busy} onClick={() => start(() => engine.startHostedLink(owner), owner)}>
                <Spin on={busy === 'connect'} /><Icons.ExternalLink className="h-4 w-4" />Connect
              </Button>
              {env === 'sandbox' && (
                <Button variant="outline" disabled={owner.length < 1 || !!busy}
                        onClick={() => run('sandbox', async () => { await engine.connectSandbox(owner); await done(); })}>
                  <Spin on={busy === 'sandbox'} />Add a test bank
                </Button>
              )}
            </div>
          )}
          {link && (
            <LinkWait engine={engine} link={link}
                      onCancel={() => setLink(undefined)}
                      onDone={async (r) => { setLink(undefined); setLinked({ ...r, reconnect: Boolean(link.itemId) }); setOwner(''); await done(); }} />
          )}
          {linked && !link && (
            <Alert>
              <Icons.CheckCircle className="h-4 w-4 text-green-600" />
              <AlertTitle>{linked.reconnect ? 'Reconnected' : 'Connected'} {linked.institution} · {plural(linked.accounts, 'account')}</AlertTitle>
              <AlertDescription className="flex flex-wrap gap-2 pt-2">
                <Button size="sm" variant="outline" onClick={() => setLinked(undefined)}><Icons.Plus className="h-3 w-3" />Connect another</Button>
              </AlertDescription>
            </Alert>
          )}
          <p className="text-muted-foreground text-sm">
            Have a backup?{' '}
            <button type="button" className="text-primary underline underline-offset-2" onClick={() => onStep('backup')}>Restore it</button>
          </p>
        </CardContent>
      </Card>

      {Object.keys(items).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Connections</CardTitle>
            <CardDescription>Initials name the accounts not yet created in Wealthfolio. Existing accounts need to be renamed manually in Wealthfolio.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="ps-6">Initials</TableHead>
                  <TableHead>Institution</TableHead>
                  <TableHead>Products</TableHead>
                  <TableHead>Accounts checked</TableHead>
                  <TableHead className="pe-6 text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(items).map(([id, m]) => (
                  <TableRow key={id}>
                    <TableCell className="ps-6"><OwnerCell engine={engine} itemId={id} value={m.owner} onSaved={done} /></TableCell>
                    <TableCell>
                      {m.institution_name}
                      {m.reconnect && <Badge variant="destructive" className="ms-2">Reconnect needed</Badge>}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{(m.products ?? []).join(', ')}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{ago(m.checked)}</TableCell>
                    <TableCell className="pe-6 text-end">
                      <div className="flex justify-end gap-2">
                        <Button variant={m.reconnect ? 'default' : 'outline'} size="sm" disabled={!!busy || !!link} onClick={() => start(() => engine.startReconnect(id), m.owner, id)}>
                          Reconnect
                        </Button>
                        <Button variant="ghost" size="sm" disabled={!!busy} aria-label={`Remove ${m.institution_name}`} onClick={() => setRemoving(id)}>
                          <Icons.Trash className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Add an existing connection</CardTitle>
          <CardDescription>Paste one access token. Does not use a new Plaid connection.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-1">
            <Label htmlFor="tok">Access token</Label>
            <Input id="tok" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off"
                   placeholder={`access-${env}-…`} className="font-mono text-xs" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tok-owner">Initials</Label>
            <Input id="tok-owner" className="w-28" maxLength={4} value={tokOwner} onChange={(e) => setTokOwner(e.target.value.toUpperCase())} />
          </div>
          {/* Stays enabled while it shows Added, so the label is not dimmed; a click then does nothing. */}
          <Button className="min-w-32" disabled={!added && (!token.trim() || !tokOwner || !!busy)}
                  onClick={() => !added && run('existing', async () => {
                    await engine.addToken(tokOwner, token);
                    setToken('');
                    flashAdded();
                    await done();
                  })}>
            <Spin on={busy === 'existing'} /><FlashLabel on={added} done="Added">Add</FlashLabel>
          </Button>
        </CardContent>
      </Card>
      <Problem error={error} />
      <AlertDialog open={!!removing} onOpenChange={(o) => { if (!o) setRemoving(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing && items[removing]?.institution_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The addon forgets this connection and its account settings. Activities in Wealthfolio stay. Make a backup first if you
              may need the access token again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive"
                               onClick={() => { const id = removing!; run('remove', async () => { await engine.removeItem(id); await done(); }); }}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Waits for the login on Plaid's page by asking Plaid every few seconds. */
function LinkWait({ engine, link, onDone, onCancel }: { engine: Engine; link: Pending;
  onDone: (r: Extract<LinkCheck, { state: 'done' }>) => void; onCancel: () => void }) {
  const [state, setState] = useState<{ kind: 'waiting' | 'exited' | 'expired'; message?: string }>({ kind: 'waiting' });
  const busy = useRef(false);
  const finished = useRef(false); // a finished login must not be exchanged twice
  const check = useCallback(async () => {
    if (busy.current || finished.current) return;
    if (Date.now() - link.started > LINK_MS) { setState({ kind: 'expired' }); return; }
    busy.current = true;
    try {
      const r = link.itemId ? await engine.checkReconnect(link.itemId, link.linkToken) : await engine.checkHostedLink(link.owner, link.linkToken);
      if (r.state === 'done') { finished.current = true; onDone(r); }
      else if (r.state === 'exited') setState({ kind: 'exited', message: r.message });
      else setState({ kind: 'waiting' });
    } catch (e) {
      setState({ kind: 'waiting', message: msg(e) }); // a failed check is retried on the next tick
    } finally {
      busy.current = false;
    }
  }, [engine, link, onDone]);
  useEffect(() => {
    if (state.kind !== 'waiting') return;
    const t = setInterval(check, POLL_MS);
    return () => clearInterval(t);
  }, [check, state.kind]);

  if (state.kind !== 'waiting') {
    return (
      <Alert variant="destructive">
        <Icons.AlertCircle className="h-4 w-4" />
        <AlertTitle>{state.kind === 'expired' ? 'The login link expired' : 'Login not finished'}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>{state.kind === 'expired' ? 'Click Connect again for a new link.' : state.message}</span>
          <div><Button size="sm" variant="outline" onClick={onCancel}>Start again</Button></div>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="bg-muted/40 flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-2 font-medium">
        <Spin on />
        Waiting for you to finish on Plaid…
      </div>
      <span className="text-muted-foreground text-sm">
        Open the link in your browser and log in{link.itemId ? '' : ', then share every account'}. This page notices when you finish.
      </span>
      <CopyLink url={link.url} />
      {state.message && <span className="text-muted-foreground text-xs">Last check failed: {state.message}. Trying again.</span>}
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
        <button type="button" className="text-muted-foreground text-xs underline underline-offset-2" onClick={check}>Check now</button>
      </div>
    </div>
  );
}

/** Initials, saved when the field loses focus or on Enter. */
function OwnerCell({ engine, itemId, value, onSaved }: { engine: Engine; itemId: string; value: string; onSaved: () => void }) {
  const [v, setV] = useState(value);
  const { status, save } = useSave();
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v === value) return;
    save(async () => {
      try {
        await engine.setOwner(itemId, v);
      } catch (e) {
        setV(value);
        throw e;
      }
      onSaved();
    });
  };
  return (
    <SaveMark status={status}>
      <Input aria-label="Initials" className="h-8 w-20" maxLength={4} value={v} onChange={(e) => setV(e.target.value.toUpperCase())}
             onBlur={commit} onKeyDown={(e) => { // IME confirm also fires Enter; keyCode 229 covers Safari's out-of-order isComposing.
             if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) e.currentTarget.blur(); }} />
    </SaveMark>
  );
}
