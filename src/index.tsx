// Addon entry: the route, the sidebar page, and the daily sync timer.
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
  // id must match contributes.routes[].id in manifest.json.
  ctx.router.add({ id: 'plaid-importer', path: '/addons/plaid-importer', component: AddonRoute });
  ctx.onDisable(() => {
    clearTimeout(first);
    clearInterval(timer);
    host.ctx = undefined;
    host.engine = undefined;
  });
};

export default enable;
