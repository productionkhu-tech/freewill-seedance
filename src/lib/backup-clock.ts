// 문서 폴더 백업을 '언제' 쓰나 (26.10.701~). 쓰는 일은 store.ts 의 runBackup 이 하고, 여기는 시각만 정한다.
//
// 지키는 것 두 가지:
//   · 변화가 멎고 quietMs(5분) 뒤 — 한창 작업하는 동안 기록 전체를 쉬지 않고 다시 쓰지 않게.
//   · 백업에 안 들어간 변화가 '처음' 생긴 때부터 maxAgeMs(15분) 안에는 반드시. 변화가 계속 들어와도 이 마감은
//     뒤로 밀리지 않는다.
//
// ★ 26.10.306 까지의 사고: 15분을 '마지막으로 쓴 때' 부터 셌고, 켠 뒤 아직 한 번도 안 썼으면 아예 세지 않았다.
//   그래서 첫 백업은 창을 숨길 때(visibilitychange)나 5분 조용한 틈에만 났는데,
//     - 305 가 backgroundThrottling 을 끄자 visibilitychange 가 오지 않았고(숨겨도 최소화해도 'visible' — 실측),
//     - 1분마다 도는 트래커 확인이 store 에 값을 넣어 조용한 틈도 없었다(persist 는 값이 그대로여도 매번 저장한다).
//   → 켜 둔 동안 백업 0번. 사용자 PC 에서 10/5 18:32 부터 이틀, 영상 135편이 백업에 없었다(IDB 에는 다 있었다).
//   그래서 이 시계는 화면 신호나 다른 기능의 습관(폴링 주기)에 기대지 않는다.
//   확인: npx tsx scripts/backup_clock_check.ts (가짜 시계로 이 규칙들을 돌려 본다).

type Timer = ReturnType<typeof setTimeout>;

export interface BackupClockOptions {
  quietMs: number;
  maxAgeMs: number;
  fire: () => void;                                     // 쓸 때가 됐다 — store.ts runBackup
  now?: () => number;                                   // 아래 셋은 시험용(가짜 시계)
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

export interface BackupClock {
  /** 새 스냅샷이 생겼다(persist setItem). 처음이면 마감 시계를 켜고, 타이머를 다시 건다. */
  changed(): void;
  /** 스냅샷을 쓰기로 넘겼다. 시계를 끄고, 그 변화가 처음 생긴 시각을 돌려준다(실패하면 failed 에 그대로 넘긴다). */
  taken(): number;
  /** 쓰지 못했다(쓰기 실패 · 아직 쓸 수 없는 때). 그 변화는 아직 백업에 없다 — 마감 시계를 되살리고 retryMs 뒤 다시.
   *  그 사이 새 변화가 와도 그때 그대로 — 당기지도(실패를 1초마다 되풀이) 미루지도(조용해지길 5분 더) 않는다. */
  failed(firstChangeAt: number, retryMs: number): void;
  /** 썼다. */
  ok(): void;
  /** 백업이 얼마나 밀렸나(ms, 0 = 밀린 것 없음). 1분마다 불린다 — 밀린 게 있는데 타이머가 어떤 이유로든
   *  없으면 다시 건다. */
  check(): number;
}

export function createBackupClock(o: BackupClockOptions): BackupClock {
  const now = o.now ?? (() => Date.now());
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t: Timer) => clearTimeout(t));
  let since = 0;        // 백업에 안 들어간 변화가 처음 생긴 시각. 0 = 밀린 것 없음
  let notBefore = 0;    // 쓰기가 실패한 뒤 다시 해 볼 시각. 0 = 실패 중 아님
  let timer: Timer | null = null;
  let dueAt = 0;        // 타이머가 울려야 할 시각 — 1분 점검이 '멎은 타이머' 를 알아보는 데 쓴다

  const arm = (ms: number) => {
    if (timer) clearTimer(timer);
    dueAt = now() + Math.max(0, ms);
    timer = setTimer(() => { timer = null; o.fire(); }, Math.max(0, ms));
  };
  // 평소: 조용해지면 quietMs 뒤, 늦어도 마감(since + maxAgeMs).
  // 실패 뒤: 이미 쓸 때가 지난 것이라 조용해지길 기다리지 않는다 — 정해 둔 때(notBefore)에 다시.
  const due = () => {
    const t = now();
    if (notBefore) return Math.max(notBefore - t, 0);
    return Math.max(Math.min(o.quietMs, since + o.maxAgeMs - t), 0);
  };

  return {
    changed() {
      if (!since) since = now();
      arm(due());
    },
    taken() {
      const s = since;
      since = 0;
      if (timer) { clearTimer(timer); timer = null; }
      return s;
    },
    failed(firstChangeAt, retryMs) {
      if (firstChangeAt && (!since || firstChangeAt < since)) since = firstChangeAt;
      if (!since) since = now();
      notBefore = now() + retryMs;
      arm(retryMs);
    },
    ok() { notBefore = 0; },
    check() {
      if (!since) return 0;
      // 타이머가 없거나(쓰려다 그냥 돌아섬) 울릴 때를 1분 넘기고도 안 울렸으면, 원래 울렸어야 할 때에(지났으면
      // 지금) 다시 건다.
      if (!timer || now() > dueAt + 60_000) arm(dueAt - now());
      return now() - since;
    },
  };
}
