// MCP(에이전트) 쪽에서 보이는 것 — 기다리는 이유(waiting) · 기다리는 카드 취소 · 설명서(26.11.2701, 사용자 "mcp한테도 kyc 방법 제대로 알려줘야").
// 진짜 작업함(/api/agent/jobs · commands)으로 보낸다. 시험 앱 · 가짜 BytePlus · 가짜 게이트웨이. 과금 없음.
import fs from 'node:fs'; import path from 'node:path';
import P from '../lib/ports.mjs';
import { connect, sleep } from '../lib/cdp.mjs';
import { ok, done } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';

const API = P.API;
for (let i = 0; i < 300; i++) { try { if ((await (await fetch(P.HOOK + '/state')).json()).tray) break; } catch {} await sleep(500); }
await fetch(P.HOOK + '/show');
const main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini'));
for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch {} await sleep(500); }
const S = (code) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const S = M.useAppStore; ${code} })()`);
let man = null;
for (let i = 0; i < 120 && !man; i++) { try { const r = await fetch(API + '/api/agent/manual'); if (r.ok) man = await r.json(); } catch {} if (!man) await sleep(1000); }
const manual = man?.version || '';
for (let i = 0; i < 60; i++) { if (await S(`return S.getState().billingProjects.length > 0;`)) break; await sleep(1000); }
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
const post = async (p, b) => { const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { st: r.status, j: await r.json().catch(() => null) }; };
const cmd = (command, args) => post('/api/agent/commands', { manual, command, args, wait: 30 }).then((r) => r.j);
const set = (o) => fetch(P.FAKE + '/__set', { method: 'POST', body: JSON.stringify(o) });
const marks = async (tag) => (await (await fetch(P.FAKE + '/__marks')).json()).filter((m) => m.text.includes(tag)).map((m) => m.what);
const job = async (id) => (await (await fetch(API + '/api/agent/jobs/' + id)).json());

// ── 0. 설명서 — 기능 표 · 바뀐 문장(영상도 자동 인증 · 대기열 · 연결 끊김) · 옛 문장 없음
const text = JSON.stringify(man?.manual || man || {}) + (man?.text || '');
ok('0 설명서: features 에 wait_reason · 영상도 자동 인증 · queue_full · certifying · 과금됐을 수 있어요 · card.cancel 이 기다리는 카드도',
  (man?.manual?.features || []).includes('wait_reason') && /사진이든 영상이든 막히면/.test(text) && /queue_full/.test(text) && /certifying/.test(text) && /과금됐을 수 있어요/.test(text) && /기다리는 카드\(waiting 이 있는 것\)도 된다/.test(text),
  (man?.manual?.features || []));
ok('0 옛 문장("영상의 얼굴 · 인증이 실패한 사진은 실패로 돌아온다") 없음', !/영상의 얼굴 · 인증이 실패한 사진은 실패로/.test(text));

const pid = (await cmd('project.create', { name: 'AGENTWAIT ' + Date.now() % 100000 }))?.result?.id;
ok('프로젝트', !!pid);
const send = (tag, extra = {}) => post('/api/agent/jobs', { manual, projectId: pid, prompt: `${tag} 천천히 움직인다`, settings: { model: 'dreamina-seedance-2-0-260128', resolution: '480p', ratio: '16:9', duration: 5 }, ...extra });

// ── 1. 대기열이 꽉 참 → 작업 상태에 waiting queue_full · tries → card.get 도 같음 → card.cancel 로 멈춤 → 더 보내지 않음
await set({ refuse: 50, refuseCode: '', faceKeys: [], marks: [] });
const j1 = (await send('AW1')).j;
let s1 = null; for (let i = 0; i < 80; i++) { s1 = await job(j1.id); if (s1.messages?.[0]?.waiting) break; await sleep(500); }
const c1 = s1?.messages?.[0];
ok('1 작업 상태: queued · waiting "queue_full" · tries', c1?.status === 'queued' && c1.waiting === 'queue_full' && c1.tries >= 1 && !c1.taskId, s1);
const g1 = (await cmd('card.get', { id: c1?.id }))?.result;
ok('1 card.get 도 waiting queue_full', g1?.waiting === 'queue_full' && g1.status === 'queued', g1);
const x1 = await cmd('card.cancel', { id: c1?.id });
ok('1 card.cancel 로 기다리는 카드를 멈춤(아직 BytePlus 작업 없음)', x1?.status === 'done' && x1.result?.canceled === 'waiting', x1);
const n1 = (await marks('AW1')).length; await set({ refuse: 0 }); await sleep(8000);
let s1b = null; for (let i = 0; i < 20; i++) { s1b = await job(j1.id); if (s1b.status === 'done') break; await sleep(500); }
ok('1 멈춘 뒤 더 보내지 않음 · 작업은 done · 카드 failed "대기열을 기다리다 취소" · waiting 없음', (await marks('AW1')).length === n1 && !(await marks('AW1')).includes('in') && s1b.status === 'done' && s1b.messages[0].status === 'failed' && /대기열을 기다리다 취소/.test(s1b.messages[0].error) && !s1b.messages[0].waiting, s1b);

// ── 2. 실사 얼굴 사진 → 작업 상태에 waiting certifying → 같은 카드가 task 를 받음
await set({ refuse: 0, faceKeys: ['http'], marks: [] });
const j2 = (await send('AW2', { refs: [path.join(FIX, 'raw-sunrise.png')], settings: { model: 'dreamina-seedance-2-0-260128', mode: 'multimodal_reference', resolution: '480p', ratio: '16:9', duration: 5 } })).j;
const seen2 = new Set(); let s2 = null;
for (let i = 0; i < 160; i++) { s2 = await job(j2.id); const m = s2.messages?.[0]; if (m?.waiting) seen2.add(m.waiting); if (m?.taskId) break; await sleep(300); }
ok('2 실사 얼굴: 기다리는 동안 waiting "certifying" → 같은 카드가 task(에셋)', seen2.has('certifying') && !!s2.messages?.[0]?.taskId && !s2.messages[0].waiting, { seen: [...seen2], job: s2 });

// ── 3. 인증이 안 되는 칸(원본 없이 주소만 — 커넥터는 경로만 넘기므로 화면에서 만든다) — 실패 이유가 error 에
await set({ faceKeys: ['noorigin'] });
await S(`const R = await import('/src/lib/send-request.ts'); const pr = S.getState().projects.find((x) => x.id === '${pid}'); await R.sendRequest({ projectId: '${pid}', promptHtml: 'AW3 움직인다', settings: pr.settings, assets: [{ id: 'u3', type: 'image_url', url: 'https://example.com/noorigin.png', role: 'reference_image', file_name: 'noorigin.png' }] }, { warn: () => {} }); return 1;`);
let l3 = null; for (let i = 0; i < 40; i++) { l3 = (await cmd('cards.list', { projectId: pid, limit: 1 }))?.result?.cards?.[0]; if (l3?.status === 'failed') break; await sleep(500); }
ok('3 cards.list: 실패 + "[자동 인증 못 함] 이유" · waiting 없음', l3?.status === 'failed' && /\[자동 인증 못 함\]/.test(l3.error) && !l3.waiting, l3);
await set({ faceKeys: [] });
await done();
