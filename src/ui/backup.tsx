// 6. Backup: a full backup (recommended) or a connections backup (connections and tokens only), and restore.
import { Alert, AlertDescription, AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Icons } from '@wealthfolio/ui';
import { type ChangeEvent, useRef, useState } from 'react';
import type { BackupKind, Engine, Restored } from '../engine/engine';
import { type PlaidEnv, plural } from '../importer';
import { copyText, FlashLabel, host, msg, Problem, Spin, useBusy, useFlash, useTask } from './common';

const KINDS: [BackupKind, string, string][] = [
  ['full', 'Full backup', 'Connections and their access tokens, account selections, sync settings, transaction records already pushed to Wealthfolio, and Discard decisions.'],
  ['connections', 'Connections backup', 'Connections and their access tokens.'],
];

export function Backup({ engine, env, ready, onChange }: { engine: Engine; env: PlaidEnv; ready: boolean; onChange: () => void }) {
  const [made, setMade] = useState<{ kind: BackupKind; text: string; copied?: boolean }>();
  const [saved, flashSaved] = useFlash();
  const [paste, setPaste] = useState('');
  const [picked, setPicked] = useState<{ name: string; text: string }>(); // a chosen file, waiting for Restore
  const [confirm, setConfirm] = useState(false);
  const [overwrite, setOverwrite] = useState<string[]>(); // the second confirmation: connections an overwrite removes
  const source = picked?.text ?? paste;
  const file = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useBusy();
  // Restore is an engine task: its result is still shown after leaving the screen.
  const { task, busy: restoring, error: restoreError, start } = useTask(engine, 'restore');
  const restored = task && !task.running && !task.error ? task.result as Restored : undefined;

  const restore = (text: string, mode: 'merge' | 'overwrite' = 'merge') => start('restore', async () => {
    const r = await engine.restore(text, mode);
    setPaste('');
    setPicked(undefined);
    onChange(); // the page checks again whether every account is linked
    return r;
  });
  const copy = async () => {
    if (made) setMade({ ...made, copied: await copyText(made.text, box.current) });
  };
  // Wealthfolio's own file save works on every surface; a plain browser download does not reach the user in the app.
  const saveFile = () => run('save', async () => {
    if (!made) return;
    const name = `plaid-importer-${made.kind}-${env}-${new Date().toISOString().slice(0, 10)}.json`;
    // The dialog returns only whether it saved, not the name the user chose.
    const ok = await host.ctx!.api.files.openSaveDialog(made.text, name);
    if (ok !== false) flashSaved();
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Step 6: Back up</CardTitle>
          <CardDescription>A backup holds your access tokens. Anyone with the access tokens and your Plaid client ID and secret can read your account data. The backup does not hold the Plaid keys. Keep it in a password manager.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {KINDS.map(([kind, title, text]) => (
            <div key={kind} className={`flex flex-col gap-3 rounded-lg border p-4 ${kind === 'full' ? 'border-primary/50' : ''}`}>
              <div className="flex items-center gap-2 font-medium">
                <Icons.DatabaseBackup className="h-4 w-4" />{title}
                {kind === 'full' && <Badge variant="success-subtle" className="ms-auto">Recommended</Badge>}
              </div>
              <p className="text-muted-foreground flex-1 text-sm">{text}</p>
              <div>
                <Button variant={kind === 'full' ? 'default' : 'outline'} disabled={!!busy}
                        onClick={() => run(`backup-${kind}`, async () => setMade({ kind, text: await engine.backup(kind) }))}>
                  <Spin on={busy === `backup-${kind}`} />Make {kind === 'connections' ? 'connections' : 'full'} backup
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
        {made && (
          <CardContent className="flex flex-col gap-2 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{made.kind === 'full' ? 'Full backup' : 'Connections backup'} ready</span>
              <span className="text-muted-foreground text-xs">{(made.text.length / 1024).toFixed(made.text.length < 10240 ? 1 : 0)} KB</span>
              <div className="ms-auto flex flex-wrap gap-2">
                <Button size="sm" className="min-w-24" onClick={copy}><Icons.Copy className="h-3 w-3" />{made.copied ? 'Copied' : 'Copy'}</Button>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={saveFile}
                        className="min-w-32">
                  <Spin on={busy === 'save'} />
                  <FlashLabel on={saved} done="Saved" small><Icons.Download className="h-3 w-3" />Save as file…</FlashLabel>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMade(undefined)}>Hide</Button>
              </div>
            </div>
            {made.copied === false && <span className="text-destructive text-xs">Copy did not work here. Select the text below and copy it.</span>}
            <textarea ref={box} readOnly value={made.text} className="bg-muted h-24 rounded p-2 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Restore</CardTitle>
          <CardDescription>Paste a backup or choose its file. What is already here is kept. Restoring does not use new Plaid connections.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {picked ? (
            <div className="bg-muted/50 flex h-20 items-center gap-3 rounded-md border px-4 text-sm">
              <Icons.FileText className="text-muted-foreground h-5 w-5" />
              <span className="font-medium">{picked.name}</span>
              <span className="text-muted-foreground text-xs">{(picked.text.length / 1024).toFixed(1)} KB · loaded</span>
              <Button size="sm" variant="ghost" className="ms-auto" disabled={!!restoring} onClick={() => setPicked(undefined)}>Remove</Button>
            </div>
          ) : (
            <textarea value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} autoComplete="off" placeholder="{ … }"
                      className="border-input bg-background h-20 rounded-md border p-2 font-mono text-xs" />
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={!source.trim() || !!restoring} onClick={() => setConfirm(true)}><Spin on={!!restoring} />Restore</Button>
            <input ref={file} type="file" accept=".json,application/json" className="hidden"
                   onChange={(e: ChangeEvent<HTMLInputElement>) => {
                     const f = e.target.files?.[0];
                     e.target.value = '';
                     if (f) f.text().then((text) => setPicked({ name: f.name, text }));
                   }} />
            <Button variant="outline" disabled={!!restoring} onClick={() => file.current?.click()}><Icons.Upload className="h-4 w-4" />Choose a file</Button>
          </div>
          {restored && (
            <Alert>
              <Icons.CheckCircle className="h-4 w-4 text-green-600" />
              <AlertTitle>Restored {plural(restored.items, 'connection')} and {plural(restored.accounts, 'account')}</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                {restored.removed > 0 && <span>Removed {plural(restored.removed, 'connection')} the backup did not have.</span>}
                {restored.ledger === 'restored' && <span>Also restored the record of {restored.rows} pushed rows.</span>}
                {restored.ledger === 'other-wealthfolio' && (
                  <span>None of its accounts are in this Wealthfolio, so the transaction records were left out. The first push to each account checks for rows Wealthfolio already has.</span>
                )}
                {!ready && <span className="text-muted-foreground text-xs">Some accounts point to Wealthfolio accounts that are not here. Link them in step 3.</span>}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
      <Problem error={error ?? restoreError} />
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore {describe(source)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Restore merges it: connections, accounts and settings already here are kept, and the backup fills in the rest.
              Overwrite replaces them with the backup's.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="outline" className="text-destructive"
                    onClick={() => engine.overwriteLoss(source).then((lost) => { setConfirm(false); setOverwrite(lost); },
                      (e) => { setConfirm(false); host.ctx?.api.toast.error(msg(e)); })}>
              Overwrite…
            </Button>
            <AlertDialogAction onClick={() => restore(source)}>Restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!overwrite} onOpenChange={(o) => { if (!o) setOverwrite(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Overwrite with {describe(source)}?</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-2">
              <span>
                The backup replaces what is here: connections{isFull(source) ? ', account selections, sync settings and the record of pushed rows' : ''}.
                Activities in Wealthfolio are not changed. This cannot be undone.
              </span>
              {overwrite && overwrite.length > 0 && (
                <span className="text-destructive">
                  Removes {plural(overwrite.length, 'connection')} the backup does not have, with {overwrite.length === 1 ? 'its' : 'their'} access
                  token{overwrite.length === 1 ? '' : 's'} and accounts: {overwrite.join(', ')}. Adding them again costs new Plaid connections, unless you have another backup.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => restore(source, 'overwrite')}>Overwrite</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const isFull = (text: string) => { try { return JSON.parse(text.trim()).kind === 'full'; } catch { return false; } };

/** "this full backup (Sandbox, 3 connections)", from the backup's own fields; the restore checks it properly. */
function describe(text: string): string {
  try {
    const d = JSON.parse(text.trim());
    const n = Object.keys(d.items ?? {}).length;
    const kind = d.kind === 'full' ? 'full backup' : d.kind === 'connections' ? 'connections backup' : 'backup';
    const env = d.env === 'production' ? 'Production' : d.env === 'sandbox' ? 'Sandbox' : null;
    return `this ${kind}${env ? ` (${env}, ${plural(n, 'connection')})` : ''}`;
  } catch {
    return 'this backup';
  }
}
