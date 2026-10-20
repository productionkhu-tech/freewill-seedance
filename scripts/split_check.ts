// 작업창 나누기 규칙(src/lib/split.ts) — 무작위 조작으로 불변식을 검사한다.
//   npx tsx scripts/split_check.ts            (기본 20000 걸음 × 시드 5개)
// 매 걸음 뒤: ① 두 칸이 서로 다른 '있는' 프로젝트 ② currentProjectId === slots[paneFocus] ③ 조작마다 약속한 결과
// (놓은 쪽에 그 프로젝트 · 자리 바꾸면 좌우가 맞바뀜 · 닫으면 남은 칸 · 지우면 지운 것이 화면에 없음) ④ 저장 → 켜기
// 왕복(partialize · onRehydrateStorage 와 같은 규칙)에서 좌우에 뜬 프로젝트가 그대로.
import {
  pointAt, openAt, focusSlot, swapSides, closeSlot, afterRemoval, sanitizeSplit, splitValid, repairSplit,
  visibleProjectIds, slotAt, type PaneState, type PaneSide, type PaneSlot,
} from '../src/lib/split';

let failures = 0;
const fail = (msg: string, ctx: unknown) => {
  failures++;
  if (failures <= 20) console.log('✗', msg, JSON.stringify(ctx));
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// 화면에서 보이는 그대로 — 왼쪽 · 오른쪽에 뜬 프로젝트.
const view = (s: PaneState) => s.split
  ? { left: s.split.slots[slotAt(s.split, 'left')], right: s.split.slots[slotAt(s.split, 'right')] }
  : { left: s.currentProjectId, right: null as string | null };

function run(seed: number, steps: number) {
  const r = rng(seed);
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
  let projects: string[] = Array.from({ length: 6 }, (_, i) => `p${i}`);
  let nextId = 6;
  const exists = (id: string) => projects.includes(id);
  let s: PaneState = { split: null, paneFocus: 0, currentProjectId: projects[0] };

  for (let step = 0; step < steps; step++) {
    const before = s;
    const op = pick(['point', 'point', 'open', 'open', 'open', 'focus', 'swap', 'close', 'create', 'delete', 'deleteGroup', 'reload', 'corrupt']);
    const ctx: any = { seed, step, op, before };
    switch (op) {
      case 'point': {   // 목록 클릭 · 뒤로/앞으로 · 찾기
        const id = pick(projects);
        s = pointAt(s, id);
        if (s.currentProjectId !== id) fail('pointAt: 지금 프로젝트가 아님', { ...ctx, id, s });
        if (!visibleProjectIds(s).includes(id)) fail('pointAt: 화면에 없음', { ...ctx, id, s });
        // 나눠 보는 중 화면에 없던 것을 띄웠으면 손대지 않던 칸은 그대로여야 한다.
        if (before.split && !visibleProjectIds(before).includes(id)) {
          const o = (before.paneFocus === 0 ? 1 : 0) as PaneSlot;
          if (!s.split || s.split.slots[o] !== before.split.slots[o]) fail('pointAt: 다른 칸이 바뀜', { ...ctx, id, s });
        }
        break;
      }
      case 'open': {    // 끌어다 놓기 · 메뉴
        const id = pick(projects);
        const side = pick<PaneSide>(['left', 'right']);
        s = openAt(s, id, side);
        const noop = !before.split && before.currentProjectId === id;
        if (noop) { if (s !== before) fail('openAt: 한 칸에 같은 프로젝트인데 바뀜', { ...ctx, id, side, s }); break; }
        if (!s.split) { fail('openAt: 나뉘지 않음', { ...ctx, id, side, s }); break; }
        if (view(s)[side] !== id) fail('openAt: 놓은 쪽에 그 프로젝트가 아님', { ...ctx, id, side, s });
        if (s.currentProjectId !== id) fail('openAt: 놓은 칸이 손대는 칸이 아님', { ...ctx, id, side, s });
        if (!before.split && view(s)[side === 'left' ? 'right' : 'left'] !== before.currentProjectId) fail('openAt: 원래 프로젝트가 반대쪽에 없음', { ...ctx, id, side, s });
        break;
      }
      case 'focus': {
        const k = pick<PaneSlot>([0, 1]);
        s = focusSlot(s, k);
        const v0 = view(before), v1 = view(s);
        if (v0.left !== v1.left || v0.right !== v1.right) fail('focus: 칸 내용이 바뀜', { ...ctx, k, s });
        break;
      }
      case 'swap': {
        s = swapSides(s);
        const v0 = view(before), v1 = view(s);
        if (before.split && (v0.left !== v1.right || v0.right !== v1.left)) fail('swap: 좌우가 안 바뀜', { ...ctx, s });
        if (s.currentProjectId !== before.currentProjectId) fail('swap: 지금 프로젝트가 바뀜', { ...ctx, s });
        break;
      }
      case 'close': {
        const k = pick<PaneSlot>([0, 1]);
        s = closeSlot(s, k);
        if (before.split) {
          const keep = before.split.slots[k === 0 ? 1 : 0];
          if (s.split || s.currentProjectId !== keep) fail('close: 남은 칸이 아님', { ...ctx, k, s });
        } else if (s !== before) fail('close: 한 칸인데 바뀜', { ...ctx, s });
        break;
      }
      case 'create': {  // 새 프로젝트 — 손대는 칸에 연다(store createProject)
        const id = `p${nextId++}`;
        projects = [id, ...projects];
        s = pointAt(s, id);
        if (s.currentProjectId !== id) fail('create: 새 프로젝트가 안 열림', { ...ctx, id, s });
        break;
      }
      case 'delete': {
        if (projects.length < 2) break;
        const id = pick(projects);
        projects = projects.filter(x => x !== id);
        s = afterRemoval(s, exists, projects[0] ?? null);
        if (visibleProjectIds(s).includes(id)) fail('delete: 지운 것이 화면에 있음', { ...ctx, id, s });
        // 나눠 보던 칸의 것을 지웠으면 남은 칸이 그대로 떠 있어야 한다.
        if (before.split && before.split.slots.includes(id)) {
          const keep = before.split.slots.find(x => x !== id)!;
          if (s.currentProjectId !== keep) fail('delete: 남은 칸이 아님', { ...ctx, id, s });
        }
        break;
      }
      case 'deleteGroup': {   // 그룹째 — 여러 개가 한꺼번에
        if (projects.length < 4) break;
        const doomed = new Set(projects.filter(() => r() < 0.4));
        if (doomed.size === projects.length) doomed.delete(projects[0]);
        projects = projects.filter(x => !doomed.has(x));
        s = afterRemoval(s, exists, projects[0] ?? null);
        for (const id of visibleProjectIds(s)) if (doomed.has(id)) fail('deleteGroup: 지운 것이 화면에 있음', { ...ctx, id, s });
        break;
      }
      case 'reload': {  // 저장 → 켜기(store partialize · onRehydrateStorage 와 같은 규칙)
        const saved = { currentProjectId: s.split ? s.split.slots[0] : s.currentProjectId, split: JSON.parse(JSON.stringify(s.split)) };
        const sp = sanitizeSplit(saved.split, exists);
        const loaded: PaneState = sp ? { split: sp, paneFocus: 0, currentProjectId: sp.slots[0] } : { split: null, paneFocus: 0, currentProjectId: saved.currentProjectId };
        const v0 = view(s), v1 = view(loaded);
        if (s.split && (v0.left !== v1.left || v0.right !== v1.right)) fail('reload: 좌우가 달라짐', { ...ctx, loaded });
        if (!s.split && loaded.currentProjectId !== s.currentProjectId) fail('reload: 지금 프로젝트가 달라짐', { ...ctx, loaded });
        s = loaded;
        break;
      }
      case 'corrupt': { // 상태를 통째로 넣는 길이 칸을 어긋나게 했다 — 안전망(repairSplit)이 고치는가
        const bad: PaneState = pick<PaneState>([
          { ...s, currentProjectId: pick(projects) },
          { ...s, paneFocus: (s.paneFocus === 0 ? 1 : 0) as PaneSlot },
          s.split ? { ...s, split: { ...s.split, slots: [s.split.slots[0], s.split.slots[0]] } } : s,
          s.split ? { ...s, split: { ...s.split, slots: [s.split.slots[0], 'gone'] } } : s,
        ]);
        s = repairSplit(bad, exists, projects[0] ?? null);
        break;
      }
    }
    if (!splitValid(s, exists)) { fail('불변식이 깨짐', { ...ctx, s }); s = repairSplit(s, exists, projects[0] ?? null); }
    if (s.currentProjectId && !exists(s.currentProjectId)) fail('지금 프로젝트가 없는 것', { ...ctx, s });
    const vis = visibleProjectIds(s);
    if (new Set(vis).size !== vis.length) fail('같은 프로젝트가 두 칸에', { ...ctx, s });
  }
}

const STEPS = Number(process.argv[2]) || 20000;
const seeds = [1, 7, 42, 2026, 1020];
for (const seed of seeds) run(seed, STEPS);

// 손으로 고른 경우 몇 가지 — 무작위가 놓치기 쉬운 것.
{
  const A = 'A', B = 'B', C = 'C';
  const exists = (id: string) => [A, B, C].includes(id);
  let s: PaneState = { split: null, paneFocus: 0, currentProjectId: A };
  s = openAt(s, B, 'right');
  if (view(s).left !== A || view(s).right !== B || s.currentProjectId !== B) fail('A|B 열기', s);
  s = openAt(s, A, 'right');   // 왼쪽 A 를 오른쪽에 놓으면 자리 바꾸기
  if (view(s).left !== B || view(s).right !== A || s.currentProjectId !== A) fail('왼쪽 것을 오른쪽에 → 자리 바꾸기', s);
  s = pointAt(s, C);           // 손대는 칸(오른쪽, A)을 C 로
  if (view(s).left !== B || view(s).right !== C) fail('손대는 칸에 C', s);
  s = pointAt(s, B);           // 다른 칸에 떠 있는 B → 그 칸으로 손만 옮김
  if (view(s).left !== B || view(s).right !== C || s.currentProjectId !== B) fail('B 로 손 옮기기', s);
  s = closeSlot(s, slotAt(s.split!, 'left'));   // 왼쪽(B) 닫기 → C 하나
  if (s.split || s.currentProjectId !== C) fail('왼쪽 닫기 → 오른쪽이 남음', s);
  if (!splitValid(s, exists)) fail('손 고른 경우 불변식', s);
  // 저장된 모양이 엉망이면 버린다
  for (const raw of [null, {}, { slots: ['A'] }, { slots: ['A', 'A'] }, { slots: ['A', 'Z'] }, { slots: [1, 2] }, { slots: ['A', 'B'], firstOnRight: 'yes' }]) {
    const sp = sanitizeSplit(raw, exists);
    const ok = raw && (raw as any).slots?.[0] === 'A' && (raw as any).slots?.[1] === 'B';
    if (ok ? !sp || sp.firstOnRight !== false : sp !== null) fail('sanitizeSplit', { raw, sp });
  }
}

console.log(failures ? `실패 ${failures}건` : `통과 — ${seeds.length}개 시드 × ${STEPS} 걸음 + 손으로 고른 경우`);
process.exit(failures ? 1 : 0);
