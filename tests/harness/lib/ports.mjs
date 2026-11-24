// 슬롯마다 포트 — 0번은 사람이 만져 보는 시험 앱(play.mjs) 몫, 시험은 1번부터.
export const portsOf = (s) => (s === 0
  ? { fake: 3946, gw: 3947, app: 3958, hook: 3959, cdp: 9612 }
  : { fake: 4000 + 20 * s, gw: 4001 + 20 * s, app: 4002 + 20 * s, hook: 4003 + 20 * s, cdp: 9620 + s });
const s = Number(process.env.HARNESS_SLOT || 0), p = portsOf(s), at = (n) => `http://127.0.0.1:${n}`;
export default { SLOT: s, API: at(p.app), FAKE: at(p.fake), GW: at(p.gw), HOOK: at(p.hook), CDP: p.cdp, APP_HOST: `:${p.app}/` };
