// BytePlus 대기열이 꽉 차 거절된 요청을 차례대로 다시 보낸다(26.11.25~, 사용자 "주에 5천편 뽑는 경우도 있네" → 2번 '대기열 넘침을 자동으로 다시 보내기').
// 동시 한도를 넘는 작업은 BytePlus 가 받아서 줄을 세우고(queued), 그 줄까지 차면 429 로 거절한다 — 작업이 안 만들어졌으니 과금이 없고, 다시 보내도 두 번 만들어지지 않는다.
// 이 PC 의 줄은 하나 — 맨 앞 카드 하나만 물어본다. 카드마다 따로 물으면 PC 여러 대가 계정의 분당 한도를 함께 먹는다.
// 화면 메모리에만 있다: 앱을 끄면 카드는 '기다리다 끊김'(store closeOrphanCards)으로 남고 재생성하면 된다. UI · 스토어를 들이지 말 것.
export type LineResult = 'sent' | 'busy' | 'end';   // 나감 · 아직 꽉 참 · 더 기다릴 것 없음(다른 이유로 끝남)
export type Waiter = {
  wanted: () => boolean;                  // 아직 기다리나(취소 · 카드 지움이면 false)
  attempt: () => Promise<LineResult>;     // 보내기 전 확인까지 하고 한 번 보낸다
  tell: (tries: number) => void;          // 몇 번 물어봤는지 카드에
  giveUp: () => void;                     // 너무 오래 기다림
  left?: (sent: boolean) => void;         // 줄에서 빠짐(나감 · 끝남 · 취소) — 붙잡아 둔 것을 놓을 때
};
const FIRST_MS = 20_000, MAX_MS = 120_000, NEXT_MS = 1_500;
export const LINE_LIMIT_MS = 6 * 60 * 60 * 1000;
const jitter = (ms: number) => ms * (0.8 + Math.random() * 0.4);   // PC 여러 대가 같은 순간에 묻지 않게

const line: { w: Waiter; tries: number; since: number }[] = [];
let pumping = false;

/** 이 답이 '줄이 꽉 참' 인가 — 429 이고, 기다려도 안 풀리는 것(쓰기 한도 · 잔액 · 무료분 · 체험)이 아니다. */
export function isLineFull(status: number, data: any): boolean {
  if (status !== 429) return false;
  const e = data?.error;
  const text = e && typeof e === 'object' ? `${e.code || ''} ${e.message || ''}` : String(e || data?.msg || '');
  return !/SetLimit|Overdue|arrear|balance|insufficient|free.?(tier|trial|quota)|trial/i.test(text);
}

export function joinLine(w: Waiter): void {
  line.push({ w, tries: 0, since: Date.now() });
  void pump();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  let wait = FIRST_MS;
  try {
    while (line.length) {
      await new Promise((r) => setTimeout(r, jitter(wait)));
      for (let i = line.length - 1; i >= 0; i--) if (!line[i].w.wanted()) line.splice(i, 1)[0].w.left?.(false);
      const head = line[0];
      if (!head) break;
      let r: LineResult = 'end';
      try { r = await head.w.attempt(); } catch { r = 'end'; }
      if (r === 'busy' && Date.now() - head.since < LINE_LIMIT_MS) {
        head.tries++;
        head.w.tell(head.tries);
        wait = Math.min(MAX_MS, Math.max(FIRST_MS, wait * 1.5));
        continue;
      }
      const i = line.indexOf(head);
      if (i >= 0) line.splice(i, 1);
      if (r === 'busy') head.w.giveUp();
      head.w.left?.(r === 'sent');
      wait = NEXT_MS;   // 하나 나갔으면(또는 빠졌으면) 바로 다음 것 — 다시 꽉 찼으면 위에서 20초부터
    }
  } finally { pumping = false; }
  if (line.length) void pump();
}
