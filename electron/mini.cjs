// 미니 창(26.11.13~) — 본창을 트레이에 숨겨 두고 MCP 로 일을 맡길 때, 지금 돌고 있는 작업만 화면 구석에 띄운다.
// (아이디어: 전상필님 2026-11-13 "작업관리자 그래프를 구석에 박아 두듯이")
//
// 이 창은 데이터를 들고 있지 않다. 본창 화면이 보내는 요약(mini:state)을 받아 그리기만 한다 — 같은 기록(IndexedDB)을
// 두 창이 함께 쓰면 저장이 엉키므로 미니 창은 스토어를 아예 열지 않는다(src/main.tsx 가 ?mini=1 이면 App 을 들이지 않는다).
// 보내기 · 과금 코드 · 백업은 지금처럼 본창 화면이 한다(숨겨도 backgroundThrottling:false 라 제 속도로 돈다).
const { BrowserWindow, ipcMain, screen, Menu, app } = require('electron');
const path = require('path');
const fs = require('fs');

const MARGIN = 14;         // 화면 모서리와의 거리
// 위쪽 구석도 모서리에 바짝(14) — 사용자 2026-11-16 "이 정도는 붙어야". 처음엔 44 로 내려 최대화한 창의 최소화 · 닫기 단추 줄을
// 비켜 앉았는데, 바짝 붙는 쪽을 골랐다(가리면 미니 창을 옮기거나 닫으면 된다). 다시 비키게 하려면 이 값만 올리면 된다.
// 기본 자리는 오른쪽 위다: 윈도우 알림이 오른쪽 아래에 떠서 미니 창을 가렸다(사용자 2026-11-13).
const TOP_CLEAR = MARGIN;
const PAD = 8;             // 창 안의 그림자 여백(화면이 그린다) — 보이는 카드는 창보다 사방 8 안쪽이다
const SIZES = ['pill', 'card', 'full'];
const OPACITY = [1, 0.85, 0.7, 0.55];

// ── 자리 나누기(26.11.13~) ───────────────────────────────────────────────────────────────
// 같은 PC 의 다른 Freewill 앱(나노바나나)도 자기 미니 창을 구석에 띄운다. 두 앱은 따로 관리되므로 화면을 합치지 않고,
// 같은 구석에 오면 겹치지 않게 위아래로 쌓기만 한다(사용자 2026-11-13 "각자 관리하되 교통정리만").
//   · 각 앱은 %APPDATA%\Freewill\mini-dock\<앱>.json 자기 파일 하나만 쓰고, 남의 파일은 읽기만 한다(서로 덮어쓰지 않음).
//   · 같은 화면 · 같은 구석이면 rank 가 작은 앱이 모서리 쪽(시댄스 0, 나노바나나 1). rank 가 같으면 이름순.
//   · 보이는 동안 2초마다 at(시각)을 새로 쓴다. 6초 넘게 멈춘 기록(꺼짐 · 죽음)은 없는 셈 친다.
//   · 칸을 지우거나 뜻을 바꾸지 않는다 — 더하기만 한다(두 앱의 배포 시점이 달라도 서로 읽을 수 있게).
// 나노바나나 쪽에 넘긴 규칙과 같은 내용: HANDOFF §6 미니 창.
//
// 뒤에 앉는 창은 앞 창이 '적어 둔 칸(slot)' 이 아니라 앞 창의 **실제 자리(x · y · w · h)** 바로 아래에 앉는다(11/16~).
// 칸으로 비키던 때는 나노바나나가 실제 225 인 카드를 칸 300 으로, 펼침을 화면 전체(1364)로 적어서 — 나노바나나가 위면
// 시댄스가 80 넘게 떨어져 앉거나 화면 맨 아래로 밀려났고, 시댄스가 위면 22 로 붙어 '누가 위냐에 따라 벌어짐이 다르다'
// (사용자 11/16 캡처). 실제 자리를 읽으면 상대가 칸을 어떻게 계산하든 상관없다.
// 기록의 자리(x · y · w · h)와 칸은 '카드 + 사방 8' 창 기준이 약속이다 — 시댄스 창은 원래 그렇고(그림자 여백 PAD), 그림자가 없는
// 나노바나나도 같은 날 v2 로 카드 ± 8 을 적게 고쳤다(나노바나나 세션 11/16 _patch_slot_v2). 그래서 상대 카드 = 기록 자리에서
// pad 만큼 안쪽 — pad 칸을 적었으면 그 값, 없으면 8. 카드 사이는 STACK_GAP 22 — 화면 끝과 카드 사이(14 + 8)와 같고,
// 나노바나나가 시댄스 아래에 앉을 때(시댄스 칸 + 6, 카드 22 안쪽) 생기는 틈도 22 라 위아래가 바뀌어도 똑같다.
// 시댄스가 적는 칸은 지금 창 높이 그대로다(크기 단계마다 창이 고정이라 오르내리지 않는다).
const STACK_GAP = MARGIN + PAD;
const DOCK_STALE_MS = 6000;
const DOCK_BEAT_MS = 2000;
// 먼저 켜진 쪽이 모서리(사용자 2026-11-16 "둘 중 누가 먼저 켜지든 겹치면 안 됨"). 떠 있는 창은 움직이지 않고, 새로 켜지는 창이
// 처음부터 빈자리로 뜬다. 내놓기 전에 '켜진 시각(since)' 을 먼저 적고 CLAIM_MS 기다린 뒤 남을 본다 — 둘이 거의 같이 켜져도 서로를 본다.
// 켜진 시각이 TIE_MS 안이거나 한쪽이 since 를 안 적었으면(옛 약속) 순서(rank)로 정한다.
const CLAIM_MS = 250;
const TIE_MS = 300;

function initMini({ port, preload, getMain, showMain, onChange, dockName = 'seedance', dockRank = 0 }) {
  const dockDir = path.join(app.getPath('appData'), 'Freewill', 'mini-dock');
  const dockFile = path.join(dockDir, `${dockName}.json`);
  let win = null;
  let latest = null;              // 본창이 마지막으로 보낸 요약
  let prevActive = new Set();     // 직전 요약의 진행 중 작업 id — '새 작업' 을 알아보려고
  let prevWaiting = 0;
  let prevInLine = 0;             // 서버 작업함에서 차례를 기다리는 MCP 요청 수(아직 카드가 아님)
  let primed = false;             // 켠 직후 첫 요약에서는 띄우지 않는다(이미 돌던 작업은 '새 작업' 이 아니다)
  let size = { w: 316, h: 160 };
  let placing = false;
  // 언제 뜨고 언제 닫히나(사용자 2026-11-13 "언제 알림이 정리되는지도 꼼꼼히"):
  //   · 저절로 뜬 창(autoShown)은 목록이 비면 저절로 닫힌다 — 완료는 끝나고 90초, 실패는 10분 뒤 목록에서 빠진다(mini-feed).
  //   · 트레이에서 직접 켠 창은 직접 끌 때까지 둔다(작업 관리자 요약 보기처럼 박아 두는 용도).
  //   · 돌고 있는 일이 있을 때 사용자가 닫으면(dismissed) 그 일이 다 끝날 때까지는 새 요청이 와도 다시 안 띄운다
  //     — 에이전트가 줄줄이 보낼 때 닫자마자 또 뜨는 것을 막는다. 다 끝나거나, 본창을 트레이로 숨기면(직접 한 일) 풀린다.
  let autoShown = false;
  let dismissed = false;
  let room = 640;                 // 이 창이 쓸 수 있는 높이(화면 높이 − 여백 − 같은 구석 앞 창 몫). 화면이 넘치면 목록이 스크롤된다.
  const MAX_H = 640;

  // 핀(26.11.16~, 사용자 "고정모드랑 (엣지 붙는) 자유롭게 둘 수 있는 모드 둘 다") — 나노바나나 미니 창의 핀과 같은 약속:
  //   pinned(기본) : 끌어 놓으면 가까운 구석에 붙고, 같은 구석의 다른 앱 창과 쌓인다.
  //   자유(false)  : 놓은 자리에 그대로. 크기를 바꾸면 화면 가장자리에 가까운 쪽 끝을 붙잡고 자란다. 쌓기에서 빠진다 —
  //                  자리 파일에 free:true 를 적고, 읽는 쪽은 그 기록을 없는 셈 친다(겹치면 옮긴 사람 몫). 놓은 자리는 다음에도(pos).
  //   다시 고정하면 가장 가까운 구석으로 — 거기선 나중에 온 쪽이다.
  const prefsPath = path.join(app.getPath('userData'), 'mini-window.json');
  const prefs = { corner: 'tr', opacity: 1, size: 'card', auto: true, pinned: true, pos: null, screen: null };
  try { Object.assign(prefs, JSON.parse(fs.readFileSync(prefsPath, 'utf8'))); } catch { /* 처음 */ }
  if (!SIZES.includes(prefs.size)) prefs.size = 'card';
  prefs.pinned = prefs.pinned !== false;
  const save = () => { try { fs.writeFileSync(prefsPath, JSON.stringify(prefs)); } catch { /* 못 써도 동작엔 지장 없음 */ } };

  const alive = () => !!win && !win.isDestroyed();
  // 실제 창은 카드 그대로(불투명 — create 참고). 자리 계산 · 자리 파일 · 설정의 pos 는 전처럼 '카드 + 사방 PAD' 가상 창으로 한다 —
  // 그래야 쌓기 계산과 나노바나나와의 약속(기록 = 카드 + 8)이 그대로다. 읽을 때 vb() 로 넓히고, 놓을 때 toReal() 로 좁힌다.
  const vb = () => { const b = win.getBounds(); return { x: b.x - PAD, y: b.y - PAD, width: b.width + 2 * PAD, height: b.height + 2 * PAD }; };
  const toReal = (b) => ({ x: b.x + PAD, y: b.y + PAD, width: Math.max(1, b.width - 2 * PAD), height: Math.max(1, b.height - 2 * PAD) });
  const visible = () => alive() && win.isVisible();
  const display = () => (alive() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay());
  const area = () => display().workArea;
  const nearestCorner = (b, a) => (b.y + b.height / 2 < a.y + a.height / 2 ? 't' : 'b') + (b.x + b.width / 2 < a.x + a.width / 2 ? 'l' : 'r');
  const clampRoom = (r) => Math.max(120, Math.min(MAX_H, Math.round(r)));

  // 자리 파일의 좌표 = **그 모니터의 물리 픽셀 ÷ 그 모니터 배율**(원점까지 같은 배율로 나눈 값) — 나노바나나가 Win32 로 재서 적는 값.
  // Electron 의 DIP 는 주 모니터(원점 0,0)에서는 이것과 같지만 다른 모니터에서는 원점이 다르다: 이 PC 의 왼쪽 100% 모니터는 위 끝이
  // 물리 430 인데 DIP 로는 286(주 모니터 배율 150% 로 줄여 붙인 자리). 그래서 같은 모니터를 서로 '다른 화면' 으로 보고 비키지 않아
  // 겹쳤다(사용자 11/16 "모니터 바뀌니까 서로 가려용"). 모니터마다 이 차이(shift)를 더해 적고, 빼서 읽는다. 크기(w · h)는 그대로.
  // 맥 등 dipToScreenRect 가 없는 곳은 DIP 가 곧 약속 좌표(shift 0).
  const shiftOf = (d) => {
    if (typeof screen.dipToScreenRect !== 'function') return { x: 0, y: 0 };
    try {
      const p = screen.dipToScreenRect(null, d.bounds);
      const s = d.scaleFactor || 1;
      return { x: p.x / s - d.bounds.x, y: p.y / s - d.bounds.y };
    } catch { return { x: 0, y: 0 }; }
  };
  // 같은 화면 · 같은 구석에서 나보다 먼저 앉은(앞) 다른 앱 창들의 '보이는 카드' 위 · 아래 끝(내 DIP).
  // 내 카드가 놓일 가로 범위(x0~x1)와 겹치는 것만 — 옆으로 비켜 앉은 창(나노바나나의 '옆에 앉기')은 비킬 것이 없다.
  // 상대가 물리 픽셀 그대로 적었으면(배율 125% 등) 그 화면 크기가 내 화면 × 배율과 맞으므로, 그때는 자리도 배율로 나눠 읽는다.
  // 상대의 scale 칸은 믿지 않는다 — 나노바나나는 100% 모니터에서도 1.5(시스템 배율)를 적는다(11/16 실측).
  const near = (p, q, tol = 1) => Math.abs(Number(p) - q) <= tol;
  const lastGood = new Map();   // 파일 이름 → 마지막으로 제대로 읽은 기록
  const sameArea = (x, a, k) => !!x && near(x.x, a.x * k, 2) && near(x.y, a.y * k, 2) && near(x.width, a.width * k, 2) && near(x.height, a.height * k, 2);
  // 같은 화면 · 같은 구석 · 가로로 겹치는 다른 앱 카드 전부 — before 는 나보다 앞(모서리 쪽)인지.
  const neighbours = (a, x0, x1) => {
    const d = display();
    const s = d.scaleFactor || 1;
    const sh = shiftOf(d);
    const ca = { x: a.x + sh.x, y: a.y + sh.y, width: a.width, height: a.height };   // 약속 좌표로 본 내 화면
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dockDir).filter((f) => f.endsWith('.json') && f !== `${dockName}.json`); } catch { return out; }
    const now = Date.now();
    for (const f of names) {
      let e;
      // 남이 쓰는 순간(이름 바꾸기 중)에 읽으면 실패한다 — 그때 '없는 셈' 치면 구석으로 올라갔다 도로 내려온다(들썩임).
      // 직전에 제대로 읽은 기록을 쓴다(그 기록도 6초 지나면 아래 at 검사로 빠진다).
      try { e = JSON.parse(fs.readFileSync(path.join(dockDir, f), 'utf8')); lastGood.set(f, e); } catch { e = lastGood.get(f); }
      if (!e || !e.visible || e.free || !(now - Number(e.at) < DOCK_STALE_MS) || e.corner !== prefs.corner) continue;
      const k = sameArea(e.area, ca, 1) ? 1 : (s !== 1 && sameArea(e.area, ca, s) ? s : 0);
      if (!k) continue;   // 다른 화면
      const rankBefore = Number(e.rank) < dockRank || (Number(e.rank) === dockRank && String(e.app) < dockName);
      const es = Number(e.since) || 0;
      const before = es > 0 && since > 0 && Math.abs(es - since) > TIE_MS ? es < since : rankBefore;   // 먼저 켜진 쪽이 앞
      const p = (e.pad === undefined || e.pad === null ? PAD : Math.max(0, Number(e.pad) || 0)) / k;   // 없으면 약속대로 8
      const ex = Number(e.x) / k - sh.x, ey = Number(e.y) / k - sh.y, ew = Number(e.w) / k, eh = Number(e.h) / k;   // 약속 좌표 → 내 DIP
      if (![ex, ey, ew, eh].every(Number.isFinite) || ew <= 2 * p || eh <= 2 * p) continue;
      if (ex + ew - p <= x0 || ex + p >= x1) continue;
      // now = 커지려고 기다리는 창의 지금 실제 자리(x · y · h 는 갈 자리). 쌓기는 갈 자리로, '비켰나' 는 실제 자리로 본다.
      const nw = e.now && [e.now.y, e.now.h].every((v) => Number.isFinite(Number(v))) ? { y: Number(e.now.y) / k - sh.y, h: Number(e.now.h) / k } : { y: ey, h: eh };
      out.push({ top: ey + p, bottom: ey + eh - p, before, nowTop: nw.y + p, nowBottom: nw.y + nw.h - p });
    }
    return out;
  };
  const ahead = (a, x0, x1) => neighbours(a, x0, x1).filter((e) => e.before);
  let since = 0;          // 이 구석에 켜진 시각(숨으면 0) — 같은 구석의 앞뒤를 정한다
  let showSeq = 0;        // 켜기 예약 번호 — 기다리는 사이에 닫히면 그 켜기는 버린다
  let placedArea = null;  // 마지막으로 앉은 화면(다른 모니터로 끌어 옮기면 거기선 나중에 온 쪽)
  let future = null;      // 커지기 전에 먼저 알린 자리 — 뒤 창이 비킬 때까지 자리 파일엔 이걸 적는다(place 참고)
  const writeDock = (isVisible) => {
    try {
      fs.mkdirSync(dockDir, { recursive: true });
      const real = alive() ? vb() : { x: 0, y: 0, width: size.w, height: size.h };
      const b = future || real;
      const d = display();
      const sh = shiftOf(d);   // DIP → 약속 좌표(물리 ÷ 그 모니터 배율)
      const a = d.workArea;
      // slot = 지금 창 높이(나노바나나는 이 칸 + 6 만큼 비켜 앉는다) · pad · free 는 11/16 에 더한 칸
      // 커지려고 기다리는 동안은 x · y · h 에 갈 자리를, now 에 지금 실제 자리를 적는다(11/16 더한 칸).
      const body = JSON.stringify({ app: dockName, rank: dockRank, corner: prefs.corner,
        x: Math.round(b.x + sh.x), y: Math.round(b.y + sh.y), w: b.width, h: b.height,
        visible: !!isVisible, at: Date.now(), area: { x: Math.round(a.x + sh.x), y: Math.round(a.y + sh.y), width: a.width, height: a.height },
        scale: d.scaleFactor || 1, slot: b.height, since: isVisible ? since : 0, pad: PAD, free: !prefs.pinned,
        ...(future ? { now: { x: Math.round(real.x + sh.x), y: Math.round(real.y + sh.y), w: real.width, h: real.height } } : {}) });
      const tmp = `${dockFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, dockFile);   // 반쯤 쓴 파일을 남이 읽지 않게
    } catch { /* 못 써도 내 창은 그대로 돈다 */ }
  };

  // 고정: 고른 모서리에 붙는다. 크기가 바뀌어도 그 모서리를 기준으로 자라고, 같은 구석 앞 창의 카드 바로 아래(아래 구석은 위)에 앉는다.
  // 남은 높이(room)를 화면에 알려 목록을 그 안에 맞추게 한다(많이 돌려도 · 작은 화면이어도 · 앞 창이 커도 화면 밖으로 안 나가게).
  // 기둥 아래(위)에 남은 높이가 MIN_ROOM 보다 작으면 **옆 기둥**(안쪽으로 카드 폭 + 22)에 앉는다 — 나노바나나의 '옆에 앉기' 와 같다.
  // 화면이 꽉 찼을 때(작은 화면 · 창 셋에 둘이 펼침) 맨 뒤 창이 화면 끝에 눌려 앞 창 위에 얹히던 것(11/16 창 셋 · 1080 화면 시험).
  // 옆 기둥도 차 있으면 그다음 기둥, 셋 다 안 되면 첫 기둥에서 화면 안에만 남긴다. 옆 기둥 창은 가로로 안 겹치니 첫 기둥 창들은 안 비킨다.
  const MIN_ROOM = 120;
  const layoutPinned = () => {
    const a = area();
    const right = prefs.corner[1] === 'r';
    const step = size.w - 2 * PAD + STACK_GAP;
    let first = null;
    for (let col = 0; col < 3; col++) {
      const x = right ? a.x + a.width - size.w - MARGIN - col * step : a.x + MARGIN + col * step;
      if (x < a.x || x + size.w > a.x + a.width) break;
      const list = ahead(a, x + PAD, x + size.w - PAD);
      let raw, y;
      if (prefs.corner[0] === 't') {
        let t = a.y + TOP_CLEAR;   // 내 창 위 끝
        for (const e of list) t = Math.max(t, e.bottom + STACK_GAP - PAD);
        raw = a.y + a.height - MARGIN - t;
        y = t;
      } else {
        let bot = a.y + a.height - MARGIN;   // 내 창 아래 끝
        for (const e of list) bot = Math.min(bot, e.top - STACK_GAP + PAD);
        raw = bot - a.y - TOP_CLEAR;
        y = bot - Math.min(size.h, clampRoom(raw));
      }
      const r = clampRoom(raw);
      const h = Math.min(size.h, r);
      y = Math.max(a.y, Math.min(y, a.y + a.height - h));   // 끝까지 밀려도 화면 안에는 남는다(그때는 겹치더라도 보이는 쪽을 고른다)
      const L = { a, x: Math.round(x), y: Math.round(y), h, room: r };
      if (!first) first = L;
      if (raw >= MIN_ROOM || !list.length) return L;
    }
    return first;
  };
  // 자유: 놓은 자리에 그대로. 크기가 바뀌면 화면 가장자리에 가까운 쪽(오른쪽 절반이면 오른쪽 끝, 아래 절반이면 아래 끝)을 붙잡고 자란다.
  const layoutFree = () => {
    const b = vb();
    const a = area();
    const r = clampRoom(a.height - TOP_CLEAR - MARGIN);
    const h = Math.min(size.h, r);
    let x = b.x + b.width / 2 > a.x + a.width / 2 ? b.x + b.width - size.w : b.x;
    let y = b.y + b.height / 2 > a.y + a.height / 2 ? b.y + b.height - h : b.y;
    x = Math.max(a.x, Math.min(x, a.x + a.width - size.w));
    y = Math.max(a.y, Math.min(y, a.y + a.height - h));
    return { a, x: Math.round(x), y: Math.round(y), h, room: r };
  };
  let placingTimer = null;
  const setBoundsQuiet = (bounds) => {   // 내가 옮기는 것 — 'moved'(사용자가 끌어 놓음)로 읽지 않게
    placing = true;
    win.setBounds(toReal(bounds));
    clearTimeout(placingTimer);
    placingTimer = setTimeout(() => { placing = false; }, 250);
  };
  // 마지막으로 잡은 고정 자리 — 1초 점검은 이것이 바뀔 때(앞 창이 커지거나 줄거나 닫힘)만 다시 앉는다. 지금 창 자리와 비교하면
  // 사용자가 끌고 있는 동안(창이 자리를 벗어나 있다) 구석으로 도로 잡아당긴다(11/16 시험에서 잡음).
  let lastTarget = '';
  const minRealH = new Map();   // 모니터 배율 → Windows 가 허락하는 가장 낮은 창 높이(재 본 값)
  const targetKey = (L) => `${L.a.x},${L.a.y},${L.a.width},${L.a.height}|${L.x},${L.y},${L.h},${L.room}`;
  let userMoveAt = 0;     // 사용자가 끌고 있는 중(will-move 는 손으로 옮길 때만 온다) — 그동안은 따라 움직이지 않는다
  // 뒤 창 쪽으로 커질 때는 **먼저 알리고, 뒤 창이 비킨 뒤에 커진다**(11/16 마지막 점검 — 그냥 커지면 뒤 창이 따라올 때까지 0.05~0.15초
  // 덮었다가 뒤 창이 뚝 떨어졌다. 나노바나나도 같은 날 똑같이 고쳤다 — 그쪽 GROW_WAIT 1.3초). 새 자리를 자리 파일에 먼저 적고(future)
  // 0.05초마다 보다가 새 카드와 겹치는 뒤 창 카드가 없어지면(또는 1.3초가 지나면 — 옛 판이라 안 비키는 앱) 그때 커진다.
  // 기다림을 끝내는 기준은 '겹치지 않음' 이다(틈 22 가 아니라). 화면이 꽉 차면 맨 뒤 창은 화면 끝에 눌려 틈이 22 가 못 되는데,
  // 22 를 기다리면 1.3초 내내 기다리는 동안 앞 창이 그 창을 덮었다(11/16 창 셋 · 1080 화면 시험). 자리가 있으면 뒤 창은 어차피 22 로 간다.
  // 줄거나 멀어질 때 · 뒤 창이 없을 때는 바로. 기다리는 사이 새 자리 잡기가 오면 그쪽이 마저 한다(placeSeq).
  const GROW_WAIT_MS = 1300;
  let placeSeq = 0;
  const clashes = (L, b) => {
    const top = prefs.corner[0] === 't';
    if (top ? L.y + L.h <= b.y + b.height : L.y >= b.y) return false;   // 그쪽으로 커지지 않는다
    const edge = top ? L.y + L.h - PAD : L.y + PAD;   // 새 카드 끝
    // 뒤 창의 '실제' 자리로 본다 — 뒤 창도 자기 뒤 창을 기다리느라 갈 자리만 적어 두고 아직 안 갔을 수 있다(창 셋 시험에서 0.5초 덮음)
    return neighbours(L.a, L.x + PAD, L.x + size.w - PAD).some((e) => !e.before && (top ? e.nowTop < edge : e.nowBottom > edge));
  };
  const place = () => {
    if (!alive()) return;
    const seq = ++placeSeq;
    const L = prefs.pinned ? layoutPinned() : layoutFree();
    if (prefs.pinned && win.isVisible()) {
      const b = vb();
      if (clashes(L, b)) {
        future = { x: L.x, y: L.y, width: size.w, height: L.h };
        writeDock(true);
        const t0 = Date.now();
        const tick = () => {
          if (seq !== placeSeq || !alive()) return;
          if (Date.now() - t0 < GROW_WAIT_MS && clashes(L, b)) { setTimeout(tick, 50); return; }
          apply(L);
        };
        setTimeout(tick, 50);
        return;
      }
    }
    apply(L);
  };
  const apply = (L) => {
    future = null;
    lastTarget = prefs.pinned ? targetKey(L) : '';
    placedArea = L.a;
    if (L.room !== room) { room = L.room; sendPrefs(); }
    setBoundsQuiet({ x: L.x, y: L.y, width: size.w, height: L.h });
    // Windows 는 이 창을 실제 57px(시스템 배율 150% 기준) 보다 낮게 못 만든다 — 알약(카드 34)이 150% 모니터에서 38, 100% 모니터에서 56 으로 잡혀
    // 아래 끝이 밀렸다(11/16 실측 · minHeight 를 줘도 · thickFrame 을 꺼도 같음, 나노바나나 창도 같은 제약). 실제로 잡힌 높이를 재서 화면에 알려
    // 알약 상자를 그 높이로 채우고 가운데 정렬한다(모니터 배율마다 따로 잰다).
    const realH = win.getBounds().height, want = L.h - 2 * PAD, s = display().scaleFactor || 1;
    // 낮은 창(알약)일 때만 — 150% 에서 홀수 좌표는 반 픽셀이라 300 이 301 로 잡히기도 해서, 그걸 최소 높이로 읽으면 알약이 285 가 된다
    // 잰 값도 작을 때만 믿는다(< 60) — 크기를 바꾸는 찰나에 아직 옛 높이가 읽히면 그걸 최소 높이로 배워 알약이 커졌다(11/16 73 으로 잡힌 기록).
    if (want < 60 && realH > want + 1 && realH < 60 && realH !== minRealH.get(s)) { minRealH.set(s, realH); sendPrefs(); }
    if (!prefs.pinned) { const b = vb(); prefs.pos = { x: b.x, y: b.y, w: b.width, h: b.height }; save(); }
    else {
      // 고정 창이 앉은 모니터를 기억한다(그 화면 가운데 점) — 앱을 다시 켜도 그 모니터의 그 구석으로(전엔 늘 주 모니터로 갔다).
      const c = { x: Math.round(L.a.x + L.a.width / 2), y: Math.round(L.a.y + L.a.height / 2) };
      if (!prefs.screen || prefs.screen.x !== c.x || prefs.screen.y !== c.y) { prefs.screen = c; save(); }
    }
    writeDock(win.isVisible());
  };
  // 고정 창을 다시 켤 때 — 기억한 모니터로 먼저 옮겨 놓고 앉는다(그 모니터가 없어졌으면 가장 가까운 모니터).
  const restorePinned = () => {
    const c = prefs.screen;
    if (!prefs.pinned || !c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !alive() || win.isVisible()) return;
    const a = screen.getDisplayNearestPoint({ x: Math.round(c.x), y: Math.round(c.y) }).workArea;
    if (sameArea(area(), a, 1)) return;
    setBoundsQuiet({ x: a.x + MARGIN, y: a.y + TOP_CLEAR, width: size.w, height: Math.min(size.h, a.height) });
  };
  // 자유 창을 다시 켤 때 — 지난번 놓은 자리에서 시작한다(그 모니터가 없어졌으면 layoutFree 가 가까운 화면 안으로 넣는다).
  const restoreFree = () => {
    const p = prefs.pos;
    if (prefs.pinned || !p || ![p.x, p.y, p.w, p.h].every(Number.isFinite) || !alive() || win.isVisible()) return;
    setBoundsQuiet({ x: Math.round(p.x), y: Math.round(p.y), width: Math.round(p.w), height: Math.round(p.h) });
  };
  // 보이는 동안: 살아 있다고 알리고(2초), 앞 창이 커지거나 줄거나 닫히면 따라 움직인다. 자유 창은 남을 따라가지 않는다.
  // 따라가기는 자리 파일 폴더를 지켜보다가 남의 파일이 바뀌면 바로(0.04초 뒤) — 1초 점검만 있을 때는 앞 창이 커지는 순간 최대 1초 동안
  // 뒤 창을 덮었다가 뒤 창이 뚝 떨어졌다(11/16 마지막 점검). 1초 점검은 지켜보기가 놓친 때를 위한 안전망으로 남긴다.
  setInterval(() => { if (visible()) writeDock(true); }, DOCK_BEAT_MS);
  let followTimer = null;
  const follow = () => {
    // future: 커지려고 기다리는 중 — 그 기다림이 마저 앉는다. 방금 내가 옮긴 직후(placing)여도 기다리지 않는다 — 창 셋이 줄줄이 비킬 때
    // 뒤 창이 0.25초씩 늦어 그동안 앞 창이 덮었다(placing 은 'moved' 를 사용자가 끌어 놓은 것으로 읽지 않게 하는 데만 쓴다).
    if (!visible() || !prefs.pinned || future || Date.now() - userMoveAt < 1500) return;
    if (targetKey(layoutPinned()) !== lastTarget) place();
  };
  setInterval(follow, 1000);
  try {
    fs.mkdirSync(dockDir, { recursive: true });
    fs.watch(dockDir, (_ev, name) => {
      if (name && String(name).startsWith(`${dockName}.json`)) return;   // 내 파일(과 내 임시 파일)
      clearTimeout(followTimer);
      followTimer = setTimeout(follow, 40);
    }).on('error', () => { /* 지켜보기가 끊겨도 1초 점검이 있다 */ });
  } catch { /* 지켜보기를 못 해도 1초 점검이 있다 */ }
  app.on('before-quit', () => writeDock(false));
  // 화면 배치가 바뀌면(작업 표시줄 크기 · 해상도 · 모니터 뽑음) 다시 앉는다 — 고정은 구석으로, 자유는 화면 안으로.
  const onDisplays = () => { if (visible() && !placing) place(); };
  screen.on('display-metrics-changed', onDisplays);
  screen.on('display-removed', onDisplays);

  // 핀 켜고 끄기 — 머리줄 핀 단추 · 우클릭 메뉴.
  const setPinned = (v) => {
    v = !!v;
    if (prefs.pinned === v) return;
    prefs.pinned = v;
    if (alive()) {
      const b = vb();
      if (v) { prefs.corner = nearestCorner(b, area()); if (visible()) since = Date.now(); }   // 그 구석에선 나중에 온 쪽
      else prefs.pos = { x: b.x, y: b.y, w: b.width, h: b.height };
    }
    save(); sendPrefs();
    if (visible()) place(); else writeDock(false);
  };

  function sendPrefs() { if (alive()) win.webContents.send('mini:prefs', { size: prefs.size, room, pinned: prefs.pinned, minH: minRealH.get(display().scaleFactor || 1) || 0 }); }
  // 보이고 숨는 게 바뀔 때마다 — 트레이 메뉴를 다시 그리고, 본창 사이드바의 '미니 창 ON/OFF' 도 따라오게 알린다.
  function changed() {
    onChange?.();
    const m = getMain();
    if (m && !m.isDestroyed()) m.webContents.send('mini:visible', visible());
  }

  const create = () => {
    win = new BrowserWindow({
      width: size.w - 2 * PAD, height: size.h - 2 * PAD,
      // 불투명 창(11/16~): 투명 창은 Windows 가 ClearType 을 못 써서 글자가 회색 번짐뿐이었다 — 100% 모니터에서 작은 한글이 깨져 보였다
      // (사용자 "모니터별로 글자 해상도 깨지는 느낌", 실측: 글자 픽셀 중 색 번짐 0 · 나노바나나 620). 둥근 모서리 · 그림자는 Windows 11 이 그린다.
      frame: false, transparent: false, hasShadow: true, roundedCorners: true, backgroundColor: latest?.theme === 'dark' ? '#1c1c1e' : '#ffffff',
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false,
      title: 'Seedance 미니',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setOpacity(prefs.opacity);
    // 창 제목은 'Seedance 미니' 로 둔다 — 페이지 <title> 이 본창과 같은 이름으로 덮어쓰면, 같은 구석을 쓰는 나노바나나가
    // 시댄스 미니 창을 크기로 짐작해야 했다(그쪽 데모 11/13). 제목은 창을 찾는 이름이라 바꾸지 않는다.
    win.on('page-title-updated', (e) => e.preventDefault());
    win.loadURL(`http://localhost:${port}/?mini=1`);
    // 서버가 아직 안 떴을 때 켜면(트레이는 서버보다 먼저 생긴다 — 첫 실행은 키를 받느라 한참) 오류 페이지에 머물렀다(11/16 시험에서 잡음).
    // 본창처럼 1초 뒤 다시 부른다. -3(ERR_ABORTED)은 평범한 이동.
    win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      setTimeout(() => { if (alive()) win.loadURL(`http://localhost:${port}/?mini=1`); }, 1000);
    });
    win.webContents.on('did-finish-load', () => {
      sendPrefs();
      if (latest) win.webContents.send('mini:state', latest);
    });
    // 처음 켤 때도 자리를 알린 뒤 CLAIM_MS 가 지나야 내놓는다. 그 사이 닫혔으면(since 0) 내놓지 않는다.
    win.once('ready-to-show', () => {
      const my = showSeq;
      setTimeout(() => reveal(my), Math.max(0, since + CLAIM_MS - Date.now()));
    });
    win.on('will-move', () => { if (!placing) userMoveAt = Date.now(); });
    // 끌어서 놓으면 — 고정: 가까운 모서리로 붙는다(작업 관리자 요약 보기처럼 구석에 박아 두는 창) · 자유: 놓은 자리에 그대로.
    win.on('moved', () => {
      userMoveAt = 0;
      if (placing || !alive()) return;
      const b = vb();
      const a = area();
      if (!prefs.pinned) { place(); return; }   // 그 자리 그대로 — 화면 밖으로 걸쳐 놓았으면 안으로만 넣고, 자리를 기억한다
      const prevCorner = prefs.corner;
      prefs.corner = nearestCorner(b, a);
      // 다른 구석 · 다른 화면으로 옮겼으면 거기선 나중에 온 쪽 — 이미 앉아 있던 남의 창을 밀어내지 않는다
      if (prefs.corner !== prevCorner || !sameArea(placedArea, a, 1)) since = Date.now();
      save();
      place();
    });
    win.on('closed', () => { win = null; since = 0; writeDock(false); changed(); });
  };

  // auto=true 는 새 작업 · 본창 숨김으로 저절로 뜬 것, false 는 사용자가 트레이에서 켠 것.
  const show = (auto = false) => {
    if (visible()) { if (!auto) autoShown = false; return; }
    autoShown = auto;
    if (!auto) dismissed = false;
    // 자리부터 알린다 — 켜진 시각을 적고(visible) CLAIM_MS 뒤 남을 보고 앉는다. 이미 켜기를 기다리는 중이면 그대로 둔다.
    if (!since) since = Date.now();
    const my = ++showSeq;
    writeDock(true);
    if (!alive()) { create(); return; }
    setTimeout(() => reveal(my), Math.max(0, since + CLAIM_MS - Date.now()));
  };
  // 자리를 잡고 내놓는다. 그 사이 닫혔거나(since 0) 다른 켜기가 왔으면 버린다.
  function reveal(my) {
    if (my !== showSeq || !since || !alive() || win.isVisible()) return;
    restoreFree(); restorePinned(); place(); win.showInactive(); writeDock(true); changed();
  }
  const hide = () => {
    ++showSeq; since = 0;   // 기다리던 켜기도 버린다
    if (alive() && win.isVisible()) { win.hide(); writeDock(false); changed(); } else writeDock(false);
  };
  // 사용자가 닫음(× · 우클릭 메뉴 · 트레이). 돌고 있는 일이 있으면 그 일이 끝날 때까지 다시 안 띄운다.
  const close = () => { dismissed = hasActive(latest); hide(); };

  const hasActive = (s) => !!s && (s.tasks.some((t) => t.status === 'queued' || t.status === 'running') || (s.running || 0) + (s.queued || 0) + (s.inLine || 0) > 0 || s.waiting > 0);
  const mainHidden = () => {
    const m = getMain();
    return !m || m.isDestroyed() || !m.isVisible() || m.isMinimized();
  };

  ipcMain.on('mini:state', (e, snap) => {
    const m = getMain();
    if (!m || m.isDestroyed() || e.sender !== m.webContents || !snap || !Array.isArray(snap.tasks)) return;   // 본창 화면만 보낸다
    latest = snap;
    const active = new Set(snap.tasks.filter((t) => t.status === 'queued' || t.status === 'running').map((t) => t.id));
    const fresh = [...active].some((id) => !prevActive.has(id)) || (snap.waiting || 0) > prevWaiting || (snap.inLine || 0) > prevInLine;
    prevActive = active;
    prevWaiting = snap.waiting || 0;
    prevInLine = snap.inLine || 0;
    if (!hasActive(snap)) dismissed = false;   // 하던 일이 다 끝났다 — 다음 새 일부터는 다시 띄운다
    if (primed && prefs.auto && fresh && !dismissed && mainHidden() && !visible()) show(true);
    primed = true;
    if (alive()) win.webContents.send('mini:state', snap);
    // 저절로 뜬 창은 목록이 비면 저절로 닫는다(완료 90초 · 실패 10분 뒤 비워진다).
    if (autoShown && visible() && snap.tasks.length === 0 && !hasActive(snap)) hide();
  });

  const popupMenu = () => {
    if (!alive()) return;
    const label = { pill: '알약', card: '카드', full: '펼침' };
    Menu.buildFromTemplate([
      { label: '본창 열기', click: () => showMain() },
      { type: 'separator' },
      ...SIZES.map((s) => ({ label: `크기: ${label[s]}`, type: 'radio', checked: prefs.size === s, click: () => { prefs.size = s; save(); sendPrefs(); } })),
      { type: 'separator' },
      { label: '구석에 고정 (끄면 놓은 자리에 그대로)', type: 'checkbox', checked: prefs.pinned, click: () => setPinned(!prefs.pinned) },
      { type: 'separator' },
      ...OPACITY.map((o) => ({ label: `투명도 ${Math.round(o * 100)}%`, type: 'radio', checked: Math.abs(prefs.opacity - o) < 0.01, click: () => { prefs.opacity = o; save(); if (alive()) win.setOpacity(o); } })),
      { type: 'separator' },
      { label: '본창을 숨겼을 때 새 작업이 생기면 띄우기', type: 'checkbox', checked: prefs.auto, click: () => { prefs.auto = !prefs.auto; save(); onChange?.(); } },
      { label: '미니 창 닫기', click: () => close() },
    ]).popup({ window: win });
  };

  // 본창 사이드바의 '미니 창' 단추(26.11.16~) — 트레이 메뉴 '미니 창' 과 같다: 켜면 직접 켠 창(비어도 그대로), 끄면 사용자가 닫은 것.
  ipcMain.on('mini:toggle', (e) => {
    const m = getMain();
    if (!m || m.isDestroyed() || e.sender !== m.webContents) return;   // 본창 화면만
    if (visible()) close(); else show(false);
  });
  ipcMain.handle('mini:visible', () => visible());

  ipcMain.on('mini:action', (e, name, p) => {
    if (!alive() || e.sender !== win.webContents) return;   // 미니 창만 보낸다
    if (name === 'resize' && p) {
      const w = Math.max(120, Math.min(460, Math.round(Number(p.w) || 0)));
      const h = Math.max(40, Math.min(MAX_H, Math.round(Number(p.h) || 0)));
      if (w !== size.w || h !== size.h) { size = { w, h }; place(); }
    } else if (name === 'open') {
      showMain();
    } else if (name === 'goto' && p && typeof p.projectId === 'string' && typeof p.msgId === 'string') {
      showMain();
      const m = getMain();
      if (m && !m.isDestroyed()) m.webContents.send('mini:goto', { projectId: p.projectId, msgId: p.msgId });
    } else if (name === 'size' && SIZES.includes(p)) {
      prefs.size = p; save(); sendPrefs();
    } else if (name === 'pin') {
      setPinned(typeof p === 'boolean' ? p : !prefs.pinned);
    } else if (name === 'ready') {
      // 화면이 듣기 시작했다 — did-finish-load 때 보낸 첫 요약은 React 가 뜨기 전이라 놓친다. 지금 것을 다시 준다.
      sendPrefs();
      if (latest) win.webContents.send('mini:state', latest);
    } else if (name === 'menu') {
      popupMenu();
    } else if (name === 'close') {
      close();
    }
  });

  return {
    show: () => show(false), hide: close, visible,
    toggle: () => (visible() ? close() : show(false)),
    auto: () => prefs.auto,
    setAuto: (v) => { prefs.auto = !!v; save(); },
    // 본창을 트레이로 숨겼을 때 — 돌고 있는 작업이 있으면 바로 띄운다. 닫아 둠(dismissed)은 '새 요청이 와서 저절로 뜨는 것' 만
    // 막는다. 본창을 숨기는 건 사용자가 직접 한 일이고 미니 창이 있는 이유라, 닫아 둠을 풀고 띄운다(11/13 손 작업 시험에서 발견).
    onMainHidden: () => { dismissed = false; if (prefs.auto && hasActive(latest)) show(true); },
  };
}

module.exports = { initMini };
