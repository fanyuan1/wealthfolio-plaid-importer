// Shared UI pieces and the host handle.
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Alert, AlertDescription, AlertTitle, Button, Icons, Input } from '@wealthfolio/ui';
import { addProgress, type Progress, type Task } from '../engine/engine';

export { addProgress };
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Engine } from '../engine/engine';

/** Set by enable(): the host context, and the one engine the page and the daily sync share. */
export const host: { ctx?: AddonContext; engine?: Engine } = {};

export const TITLE = 'Plaid Importer';
export const KEYS_URL = 'https://dashboard.plaid.com/developers/keys';
export type Step = 'setup' | 'connections' | 'accounts' | 'sync' | 'daily' | 'backup';
export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useBusy() {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
      host.ctx?.api.logger.error(`plaid-importer: ${label}: ${msg(e)}`);
    } finally {
      setBusy(undefined);
    }
  }, []);
  return { busy, error, run };
}

export function Problem({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <Icons.AlertCircle className="h-4 w-4" />
      <AlertTitle>That did not work</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

export function Spin({ on }: { on: boolean }) {
  return on ? <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" /> : null;
}

/** Wealthfolio cannot open a browser from an addon, so the user copies the link. */
export function CopyLink({ url, hint = true }: { url: string; hint?: boolean }) {
  const box = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // The addon frame may have no clipboard access: select the text and try the old way.
      box.current?.select();
      try {
        setCopied(document.execCommand('copy'));
      } catch {
        setCopied(false);
      }
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Input ref={box} readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button variant="outline" className="min-w-32" onClick={copy}><Icons.Copy className="mr-2 h-4 w-4" />{copied ? 'Copied' : 'Copy link'}</Button>
      </div>
      {hint && (
        <span className="text-muted-foreground text-xs">
          {copied ? 'Copied. Paste it in your browser.' : 'Copy, then paste in your browser.'}
        </span>
      )}
    </div>
  );
}

type State = Progress['state'];

export function StateIcon({ state }: { state: State }) {
  if (state === 'running') return <Icons.Spinner className="text-muted-foreground h-4 w-4 shrink-0 animate-spin" />;
  if (state === 'done') return <Icons.CheckCircle className="h-4 w-4 shrink-0 text-green-600" />;
  if (state === 'warn') return <Icons.AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />;
  if (state === 'error') return <Icons.XCircle className="text-destructive h-4 w-4 shrink-0" />;
  return <Icons.Circle className="text-muted-foreground h-4 w-4 shrink-0" />;
}

/** One line per connection or stage, with its accounts nested below. */
export function ProgressList({ list }: { list: Progress[] }) {
  if (!list.length) return null;
  const top = list.filter((p) => !p.parent || !list.some((x) => x.id === p.parent));
  return (
    <ul className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-md border">
      {top.map((p) => {
        const kids = list.filter((c) => c.parent === p.id);
        return (
          <li key={p.id} className="flex flex-col gap-1.5 px-4 py-2.5">
            <Line p={p} />
            {kids.length > 0 && (
              <ul className="flex flex-col gap-1 pl-6">
                {/* A line left running under a finished connection stopped there. */}
                {kids.map((c) => <li key={c.id}><Line p={c.state === 'running' && p.state !== 'running' ? { ...c, state: 'skipped', detail: 'Stopped' } : c} small /></li>)}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Line({ p, small }: { p: Progress; small?: boolean }) {
  return (
    <div className={`flex min-w-0 items-start gap-2 ${small ? 'text-xs' : 'text-sm'}`}>
      <span className="mt-0.5"><StateIcon state={p.state} /></span>
      <span className={`min-w-0 ${small ? 'text-muted-foreground' : 'font-medium'}`}>{p.label}</span>
      {p.detail && <span className={`text-muted-foreground ml-auto shrink-0 text-xs ${p.state === 'error' ? 'text-destructive' : ''}`}>{p.detail}</span>}
    </div>
  );
}

export type SaveState = 'idle' | 'saving' | 'saved';

/** Changes save at once. The control shows it (SaveMark); a failure is a toast, so nothing is added beside it. */
export function useSave() {
  const [s, setS] = useState<SaveState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const save = useCallback(async (fn: () => Promise<unknown>) => {
    clearTimeout(timer.current);
    setS('saving');
    try {
      await fn();
      setS('saved');
      timer.current = setTimeout(() => setS('idle'), 1500);
    } catch (e) {
      setS('idle');
      host.ctx?.api.toast.error(msg(e));
    }
  }, []);
  return { status: s, save };
}

/** The save result on the control itself (D57): the control fades into a green ✓ for a moment, in its own space. */
export function SaveMark({ status, children }: { status: SaveState; children: ReactNode }) {
  const done = status === 'saved';
  return (
    <span className="relative inline-flex items-center">
      <span className={`inline-flex transition-opacity duration-200 ${done ? 'opacity-0' : ''}`}>{children}</span>
      {done && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Icons.Check className="animate-in fade-in zoom-in h-4 w-4 text-green-600 duration-300" />
        </span>
      )}
    </span>
  );
}

/** A control with its own save state, for rows of controls that each show their own result. */
export function WithSave({ children }: { children: (save: (fn: () => Promise<unknown>) => void) => ReactNode }) {
  const { status, save } = useSave();
  return <SaveMark status={status}>{children(save)}</SaveMark>;
}

/** A success shown on the button that caused it, for a moment, so nothing next to the button moves (D57).
 * Give the button a min width that fits both labels. */
export function useFlash(ms = 2500): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return [on, useCallback(() => setOn(true), [])];
}

export function FlashLabel({ on, done, small, children }: { on: boolean; done: string; small?: boolean; children: ReactNode }) {
  return on
    ? <span key="done" className="animate-in fade-in zoom-in flex items-center text-green-600 duration-300"><Icons.Check className={`mr-2 ${small ? 'h-3 w-3' : 'h-4 w-4'}`} />{done}</span>
    : <span key="idle" className="animate-in fade-in flex items-center duration-300">{children}</span>;
}

export const ago = (iso?: string) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

/** A slice of the engine that re-renders the screen when it changes. pick must return a kept object, not a new one. */
export function useEngine<T>(engine: Engine, pick: (e: Engine) => T): T {
  return useSyncExternalStore(engine.subscribe, () => pick(engine));
}

/** The task under key: it keeps running, and keeps its progress, when the user leaves the screen. */
export function useTask(engine: Engine, key: string) {
  const task = useEngine(engine, (e) => e.tasks[key]) as Task | undefined;
  const start = useCallback(<T,>(label: string, fn: Parameters<Engine['task']>[2]) =>
    engine.task(key, label, fn as never).catch((e) => { host.ctx?.api.logger.error(`plaid-importer: ${key}: ${msg(e)}`); return undefined as T | undefined; }), [engine, key]);
  return { task, busy: task?.running ? task.label : undefined, error: task?.error, start };
}
