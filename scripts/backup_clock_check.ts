// 백업 시계 확인 (26.10.701~) — 가짜 시계로 src/lib/backup-clock.ts 의 약속을 돌려 본다. 몇 초면 끝난다.
//   npx tsx scripts/backup_clock_check.ts
// 첫 경우가 26.10.306 의 사고 그대로다: 1분마다 변화가 들어오는데(트래커 확인) 창은 한 번도 숨기지 않는다.
// 같은 상황을 306 의 규칙으로도 돌려서 0번이 나오는 것을 같이 보인다 — 그 규칙으로 되돌아가면 바로 보이게.
import { createBackupClock } from '../src/lib/backup-clock';

const MIN = 60_000;
const QUIET = 5 * MIN, MAX_AGE = 15 * MIN;

// 가짜 시계 + 타이머. advance(ms) 동안 걸린 타이머를 시각 순서대로 실행한다. 진짜 Date.now() 처럼 큰 값에서
// 시작한다(시계는 0 을 '밀린 것 없음' 으로 쓴다). 기록하는 시각은 시작부터 잰 값.
const T0 = Date.UTC(2026, 9, 7, 9, 0, 0);
function fakeTime() {
  let t = T0, seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id as any; },
    clearTimer: (id: any) => { timers.delete(id); },
    clearAll: () => timers.clear(),
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
  };
}

// store.ts runBackup 의 뼈대: 밀린 스냅샷이 있으면 넘기고, 결과에 따라 ok / failed.
function rig(opts: { fails?: number; notReady?: number } = {}) {
  const ft = fakeTime();
  let pending = false, fails = opts.fails ?? 0, notReady = opts.notReady ?? 0, failures = 0;
  const writes: number[] = [], attempts: number[] = [];
  const clock = createBackupClock({
    quietMs: QUIET, maxAgeMs: MAX_AGE, now: ft.now, setTimer: ft.setTimer, clearTimer: ft.clearTimer,
    fire: () => {
      if (!pending) return;
      if (notReady > 0) { notReady--; clock.failed(0, 30_000); return; }   // 어셋 목록이 아직
      pending = false;
      const since = clock.taken();
      attempts.push(ft.now() - T0);
      if (fails > 0) {
        fails--; failures++; pending = true;
        clock.failed(since, Math.min(MIN * 2 ** (failures - 1), MAX_AGE));
        return;
      }
      failures = 0; clock.ok(); writes.push(ft.now() - T0);
    },
  });
  const change = () => { pending = true; clock.changed(); };
  return { ft, clock, change, writes, attempts };
}

// 26.10.306 의 규칙(그대로 옮김): 마지막으로 쓴 때부터 15분, 한 번도 안 썼으면(0) 세지 않음.
function rig306() {
  const ft = fakeTime();
  let lastAt = 0, timer: any = null, pending = false;
  const writes: number[] = [];
  const run = () => { timer = null; if (!pending) return; pending = false; lastAt = ft.now(); writes.push(ft.now() - T0); };
  const change = () => {
    pending = true;
    if (timer) ft.clearTimer(timer);
    const overdue = lastAt > 0 && ft.now() - lastAt >= MAX_AGE;
    timer = ft.setTimer(run, overdue ? 0 : QUIET);
  };
  return { ft, change, writes };
}

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => results.push([name, ok, detail]);
const m = (ms: number) => `${(ms / MIN).toFixed(1)}분`;
const gaps = (w: number[]) => w.slice(1).map((x, i) => x - w[i]);

// 1) 사고 재현: 1분마다 변화, 숨김 없음, 2시간
{
  const r = rig(), old = rig306();
  for (let i = 0; i < 120; i++) { r.change(); old.change(); r.ft.advance(MIN); old.ft.advance(MIN); }
  const maxGap = Math.max(...gaps(r.writes));
  check('1분마다 변화 · 숨김 없음 (2시간)', r.writes.length >= 7 && r.writes[0] <= MAX_AGE && maxGap <= MAX_AGE + MIN,
    `백업 ${r.writes.length}번, 첫 백업 ${m(r.writes[0])}, 가장 긴 간격 ${m(maxGap)}  |  306 규칙: ${old.writes.length}번`);
}

// 2) 켠 직후 한 번(복원된 기록을 store 에 넣는 것도 변화다) 뒤 조용 → 5분 뒤
{
  const r = rig();
  r.change(); r.ft.advance(60 * MIN);
  check('켠 뒤 조용', r.writes.length === 1 && r.writes[0] === QUIET, `백업 ${r.writes.length}번, ${m(r.writes[0] ?? NaN)}`);
}

// 3) 몰아서 작업(20초마다 10분) 후 조용 → 작업 중 마감, 끝난 뒤 5분
{
  const r = rig();
  for (let i = 0; i < 30; i++) { r.change(); r.ft.advance(20_000); }
  r.ft.advance(30 * MIN);
  check('10분 몰아서 작업 후 조용', r.writes.length === 1 && r.writes[0] <= 10 * MIN + QUIET,
    `백업 ${r.writes.length}번, ${r.writes.map(m).join(' · ')}`);
}

// 4) 쓰기 3번 실패(디스크 꽉 참 등) → 변화가 없어도 1·2·4분 뒤 다시 → 4번째에 성공
{
  const r = rig({ fails: 3 });
  r.change(); r.ft.advance(60 * MIN);
  const a = r.attempts.map(m).join(' · ');
  check('실패 3번 뒤 새 변화 없이 다시', r.writes.length === 1 && r.attempts.length === 4, `시도 ${a} → 성공 ${m(r.writes[0] ?? NaN)}`);
}

// 5) 실패가 이어지는 동안 1분마다 변화가 와도 간격(1·2·4·8·15분)을 지킨다 — 1분마다 33MB 를 다시 쓰지 않게
{
  const r = rig({ fails: 1e9 });
  for (let i = 0; i < 120; i++) { r.change(); r.ft.advance(MIN); }
  const g = gaps(r.attempts);
  check('계속 실패 · 1분마다 변화', g.slice(3).every(x => x >= 8 * MIN) && r.clock.check() >= 45 * MIN,
    `2시간에 시도 ${r.attempts.length}번 (간격 ${g.map(m).join(' · ')}), 밀림 ${m(r.clock.check())} → 알림 조건`);
}

// 6) 어셋 목록이 늦게 올라옴 → 30초마다 다시 보다가 올라오면 쓴다(새 변화 없이)
{
  const r = rig({ notReady: 3 });
  r.change(); r.ft.advance(30 * MIN);
  check('어셋 목록이 늦게 올라옴', r.writes.length === 1 && r.writes[0] === QUIET + 90_000, `백업 ${m(r.writes[0] ?? NaN)}`);
}

// 7) 타이머가 어떤 이유로든 울리지 않음 → 1분 점검(check)이 울렸어야 할 때 + 1분 안에 다시 건다
{
  const r = rig();
  r.change(); r.ft.clearAll();
  for (let i = 0; i < 30; i++) { r.clock.check(); r.ft.advance(MIN); }
  check('타이머가 멎어도 1분 점검이 살림', r.writes.length === 1 && r.writes[0] <= QUIET + 2 * MIN, `백업 ${m(r.writes[0] ?? NaN)}`);
}

// 8) 쓰는 동안 새 변화 → 실패하면 더 오래된 시각부터 다시 센다(마감이 늦춰지지 않게)
{
  const r = rig({ fails: 1 });
  r.change(); r.ft.advance(QUIET);                  // 5분: 시도 → 실패(1분 뒤 다시)
  r.change(); r.ft.advance(30_000);                 // 그새 새 변화
  const lag = r.clock.check();
  r.ft.advance(10 * MIN);
  check('실패 사이 새 변화', lag === QUIET + 30_000 && r.writes.length === 1 && r.writes[0] === QUIET + MIN,
    `밀림 ${m(lag)} (처음 변화부터), 성공 ${m(r.writes[0] ?? NaN)}`);
}

let bad = 0;
for (const [name, ok, detail] of results) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`); }
console.log(bad ? `\n${bad}개 실패` : `\n전부 통과 (${results.length}개)`);
process.exit(bad ? 1 : 0);
