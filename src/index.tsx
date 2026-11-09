// Addon entry: the route, the sidebar item, and the daily sync timer.
// The manifest declares no `contributes`: Wealthfolio boots an addon with contributed routes only when its page is
// first opened, and the daily sync timer must run from startup.
import type { AddonEnableFunction } from '@wealthfolio/addon-sdk';
import { Engine } from './engine/engine';
import { host, msg } from './ui/common';
import { AddonRoute } from './ui/page';

const TICK_MS = 60_000; // the daily sync time has minutes

const enable: AddonEnableFunction = (ctx) => {
  host.ctx = ctx;
  const engine = (host.engine ??= new Engine(ctx.api));
  const tick = () => engine.autoSync().then((r) => {
    if (!r) return;
    if (r.status === 'ok') ctx.api.toast.success(`Daily sync: ${r.message}`);
    else ctx.api.toast.warning(`Daily sync ${r.status}: ${r.message}`);
    ctx.api.query.invalidateQueries(['activities']);
  }).catch((e) => ctx.api.logger.error(`plaid-importer: daily: ${msg(e)}`));
  const first = setTimeout(tick, 60_000); // let Wealthfolio finish starting
  const timer = setInterval(tick, TICK_MS);
  ctx.router.add({ id: 'plaid-importer', path: '/addons/plaid-importer', component: AddonRoute });
  const item = ctx.sidebar.addItem({ id: 'plaid-importer', label: 'Plaid Importer', icon: 'plugs-connected', route: '/addons/plaid-importer', order: 100 });
  ctx.onDisable(() => {
    item.remove();
    clearTimeout(first);
    clearInterval(timer);
    host.ctx = undefined;
    host.engine = undefined;
  });
};

export default enable;
