// The viewer's Buzz balance, over `GET /api/v1/blocks/buzz`.
//
// Replaces the `GET_BUZZ_BALANCE` bridge message. Scope `buzz:read:self`, which
// requires an authenticated subject — an anonymous viewer is refused, as it was
// on the bridge, so callers gate on `viewer` rather than reading a zero balance
// as "signed in with no Buzz".
//
// ℹ️ NO `query.id` WORKAROUND HERE, and that is deliberate. `@civitai/sdk`'s
// BREAKING.md tells porting apps to pass `{ query: { id: context.modelId } }` on
// every block REST route to dodge a scope-binding check that ran over EVERY scope
// on the token. That check was narrowed to the route's OWN `requiredScope`
// (civitai#5063, verified in `block-scope.middleware.ts`: *"THE BINDING SWITCH IS
// SCOPED TO `requiredScope`, NOT TO EVERY SCOPE ON THE TOKEN"*), so the
// workaround is no longer needed — and it was never available to this app anyway,
// which runs in a PAGE slot whose context carries no `modelId`.

import { getClient } from './client.js';

/** The three Buzz pools, as the route returns them: a bare object, three numbers. */
export interface BuzzBalance {
  blue: number;
  green: number;
  yellow: number;
}

/** A number the wire may have omitted becomes 0 rather than `NaN`. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export async function fetchBuzzBalance(): Promise<BuzzBalance> {
  const app = await getClient();
  const res = await app.site.get<Partial<BuzzBalance>>('blocks/buzz');
  return { blue: num(res.blue), green: num(res.green), yellow: num(res.yellow) };
}
