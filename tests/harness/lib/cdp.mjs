// 시험 앱 화면에 붙기(CDP). 'Promise was collected' 는 여기서 없앤다(11/25 실험으로 확인):
//   Runtime.evaluate 의 awaitPromise 는 약속을 붙들지 않아, 기다리던 약속을 화면 쪽에서 아무도 안 붙들면 메모리 정리 때 끊긴다.
//   → 약속을 먼저 물건(objectId)으로 받아 두면(디버거가 붙듦) 정리되지 않는다. 그다음 awaitPromise 로 기다린다.
//   다시 시도로 넘기지 않는다 — 시간이 넘으면 무엇을 기다리다 멈췄는지 적어서 던진다.
// (화면이 새로 고쳐진 경우는 'Inspected target navigated or closed' 로 따로 온다.)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = [];
/** 지금 붙어 있는 화면(실패할 때 캡처용). */
export const lastConnection = () => open[open.length - 1] || null;

export async function connect(port, match = () => true, waitMs = 60_000) {
  let page;
  for (const t0 = Date.now(); !page && Date.now() - t0 < waitMs;) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && match(t)); } catch { /* 아직 */ }
    if (!page) await sleep(500);
  }
  if (!page) throw new Error(`화면을 못 찾음(CDP ${port}, ${waitMs / 1000}초)`);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error(`화면에 붙지 못함(CDP ${port})`)); });
  let id = 0;
  const pend = new Map(), listeners = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
    for (const fn of listeners.get(d.method) || []) fn(d.params);
  };
  ws.onclose = () => { for (const fn of pend.values()) fn({ error: { message: '화면과 끊김' } }); pend.clear(); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); })
    .then((d) => { if (d.error) throw new Error(`${method}: ${d.error.message || JSON.stringify(d.error)}`); return d.result; });
  const on = (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); };
  const fail = (x) => { const e = x.exception; throw new Error((e && (e.description || e.value)) || x.text || JSON.stringify(x).slice(0, 400)); };
  /** 식 평가(약속이면 기다림). 값은 JSON 으로. */
  const ev = async (expression, { timeout = 120_000 } = {}) => {
    const first = await send('Runtime.evaluate', { expression });
    if (first.exceptionDetails) fail(first.exceptionDetails);
    const o = first.result;
    if (!o.objectId) return o.value;
    try {
      const call = o.subtype === 'promise'
        ? send('Runtime.awaitPromise', { promiseObjectId: o.objectId, returnByValue: true })
        : send('Runtime.callFunctionOn', { objectId: o.objectId, functionDeclaration: 'function () { return this; }', returnByValue: true });
      call.catch(() => {});
      let timer;
      const late = new Promise((_, j) => { timer = setTimeout(() => j(new Error('LATE')), timeout); });
      const r = await Promise.race([call, late]).finally(() => clearTimeout(timer));
      if (r.exceptionDetails) fail(r.exceptionDetails);
      return r.result.value;
    } catch (e) {
      if (e.message !== 'LATE') throw e;
      let where = '';
      try {
        const d = await Promise.race([send('Runtime.evaluate', { returnByValue: true, expression: `JSON.stringify({ 주소: location.href, 상태: document.readyState, 켠지초: Math.round(performance.now() / 1000), 마지막요청: performance.getEntriesByType('resource').slice(-4).map((x) => x.name.replace(location.origin, '') + ' ' + Math.round(x.duration) + 'ms') })` }), sleep(3000).then(() => null)]);
        where = d ? d.result.value : '화면이 답하지 않음';
      } catch (x) { where = String(x.message); }
      throw new Error(`${timeout / 1000}초 안에 안 끝남: ${expression.replace(/\s+/g, ' ').slice(0, 160)} … | ${where}`);
    } finally { send('Runtime.releaseObject', { objectId: o.objectId }).catch(() => {}); }
  };
  const c = { ws, send, on, ev, close: () => ws.close() };
  open.push(c);
  return c;
}
