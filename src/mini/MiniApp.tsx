// 미니 창 화면(26.11.13~, electron/mini.cjs). 스토어를 들이지 않는다 — 본창이 보내는 요약(MiniSnap)만 그린다.
// 크기 셋: 알약(한 줄) · 카드(두 줄까지) · 펼침(전부). 머리를 끌면 창이 움직이고(놓으면 가까운 모서리로), 우클릭은 메뉴,
// 줄을 누르면 본창의 그 카드로, 빈 곳을 두 번 누르면 본창. × 는 닫기(돌던 일이 끝날 때까지 다시 안 뜸 — mini.cjs).
// 창이 쓸 수 있는 높이(room)는 본 프로세스가 알려 준다 — 넘치면 목록만 스크롤된다.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { MiniSnap, MiniTask } from '../lib/mini-feed';

type Size = 'pill' | 'card' | 'full';
const api = (window as any).electronAPI;

const T = {
  light: { bg: '#ffffff', ink: '#1d1d1f', sub: '#6b7280', faint: '#9ca3af', line: '#eceef2', chip: '#f3f4f6', ind: '#6366f1', indSoft: '#eef2ff', good: '#16a34a', amber: '#b45309', amberSoft: '#fef3c7', red: '#dc2626', redSoft: '#fee2e2', ring: 'rgba(0,0,0,0.08)' },
  dark: { bg: '#1c1c1e', ink: '#f5f5f7', sub: '#a1a1aa', faint: '#7c7c85', line: '#2c2c31', chip: '#2c2c31', ind: '#818cf8', indSoft: '#26304d', good: '#4ade80', amber: '#fcd34d', amberSoft: '#3b2f12', red: '#f87171', redSoft: '#3a1d1d', ring: 'rgba(255,255,255,0.1)' },
};
// mini-feed 의 miniRank 와 같은 순서 — 값을 import 하면 mini-feed 가 스토어를 끌고 들어오므로(§7-54) 여기 따로 둔다.
const RANK: Record<MiniTask['status'], number> = { running: 0, queued: 1, failed: 2, succeeded: 3 };
const rank = (t: MiniTask) => (t.cancelled ? 3 : RANK[t.status]);
// mini-feed 의 miniOrder 와 같은 순서 — 진행 중 · 대기는 먼저 온 것부터(맨 위 줄이 끝날 때까지 그대로), 끝난 것은 최근에 끝난 것부터.
const order = (a: MiniTask, b: MiniTask) => rank(a) - rank(b) || (rank(a) <= 1 ? a.start - b.start : (b.end || b.start) - (a.end || a.start));
const NEXT_SIZE: Record<Size, Size> = { full: 'card', card: 'pill', pill: 'full' };   // 최대 → 카드 → 알약 → 최대
const SIZE_LABEL: Record<Size, string> = { full: '최대', card: '카드', pill: '알약' };
const CARD_BOX_H = 284;   // 카드 상자 높이(창 300 = 상자 + 그림자 여백 8 × 2, mini.cjs PAD). 가장 꽉 찬 카드(노란 코드 막대 · MCP 대기 줄 · 두 줄 · 외 N개)가 272 라 그 위로 조금
const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

export default function MiniApp() {
  const [snap, setSnap] = useState<MiniSnap | null>(null);
  const [size, setSize] = useState<Size>('card');
  const [room, setRoom] = useState(640);
  const [pinned, setPinned] = useState(true);
  const [minH, setMinH] = useState(0);   // Windows 가 허락하는 가장 낮은 창 높이(mini.cjs 가 재서 알려 줌) — 알약 상자를 이만큼 채운다
  const [now, setNow] = useState(Date.now());
  const boxRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<Size>('card');   // 크기를 알릴 때 '어느 크기로 그린 높이인지' 함께(mini.cjs 의 칸 계산)
  sizeRef.current = size;

  useEffect(() => {
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    const off1 = api?.onMiniState?.((s: MiniSnap) => setSnap(s));
    const off2 = api?.onMiniPrefs?.((p: { size: Size; room?: number; pinned?: boolean; minH?: number }) => {
      if (p?.size) setSize(p.size);
      if (p?.room) setRoom(p.room);
      if (typeof p?.pinned === 'boolean') setPinned(p.pinned);
      if (typeof p?.minH === 'number') setMinH(p.minH);
    });
    api?.miniAction?.('ready');   // 듣기 시작했으니 마지막 요약을 달라고 한다
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { off1?.(); off2?.(); window.clearInterval(t); };
  }, []);

  // 그린 크기대로 창 크기를 맞춘다. 창은 카드 그대로(불투명 · 둥근 모서리와 그림자는 Windows 가 그린다, mini.cjs create)인데,
  // 본 프로세스는 자리를 '카드 + 사방 8' 가상 창으로 계산하므로 + 16 을 붙여 알린다(mini.cjs vb · toReal).
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const send = () => { const r = el.getBoundingClientRect(); api?.miniAction?.('resize', { w: Math.ceil(r.width) + 16, h: Math.ceil(r.height) + 16, size: sizeRef.current }); };
    const ro = new ResizeObserver(send);
    ro.observe(el);
    send();
    return () => ro.disconnect();
  }, []);

  const c = T[snap?.theme === 'dark' ? 'dark' : 'light'];
  // 창 바탕 = 카드 바탕(불투명 창 — 크기가 바뀌는 찰나에 다른 색이 비치지 않게)
  useEffect(() => { document.documentElement.style.background = c.bg; document.body.style.background = c.bg; }, [c.bg]);
  const tasks = [...(snap?.tasks || [])].sort(order);
  const running = tasks.filter((t) => t.status === 'running');
  // 머리의 수는 전체 수(snap.running/queued) — 목록은 12개까지만 오므로 목록을 세면 많이 돌릴 때 모자란다
  const runCount = snap?.running ?? running.length;
  const inLine = snap?.inLine || 0;   // 아직 카드가 되지 않은 MCP 요청(서버 작업함) — '대기' 에 더한다
  const queued = (snap?.queued ?? tasks.filter((t) => t.status === 'queued').length) + inLine;
  const waiting = snap?.waiting || 0;
  const noCode = !!snap?.billing.needed && !snap?.billing.name;
  const dot = waiting || noCode ? c.amber : running.length ? c.ind : c.good;
  const longest = running.length ? Math.max(...running.map((t) => now - t.start)) : 0;
  const stat = !snap ? '연결 중…'
    : waiting ? `코드 기다림 ${waiting}${runCount ? ` · 생성 중 ${runCount}` : ''}`
    : runCount || queued ? `생성 중 ${runCount}${queued ? ` · 대기 ${queued}` : ''}`
    : '쉬는 중';
  // 알약은 폭이 고정이라 줄여 쓴다(로고가 앱 이름을 대신한다)
  const pillStat = !snap ? '연결 중…'
    : waiting ? `코드 대기 ${waiting}${runCount ? ` · 생성 ${runCount}` : ''}`
    : runCount || queued ? `생성 ${runCount}${queued ? ` · 대기 ${queued}` : ''}`
    : '쉬는 중';
  const shown = size === 'full' ? tasks : size === 'card' ? tasks.slice(0, 2) : [];
  const hiddenCount = Math.max(0, tasks.length - shown.length) + (size === 'pill' ? 0 : snap?.more || 0);
  const pill = size === 'pill';

  // 단추 · 칩은 줄어들지 않는다(flex: none). 잘려도 되는 건 프롬프트 · 프로젝트 이름 · 오류 문구뿐이고, 그건 data-clip-ok 를 달고 마우스를 올리면 전체가 보인다.
  const btn: CSSProperties = { width: 22, height: 22, flex: 'none', borderRadius: 6, display: 'grid', placeItems: 'center', color: c.faint, background: 'transparent', border: 0, cursor: 'pointer', padding: 0, WebkitAppRegion: 'no-drag' } as any;
  const chip = (bg: string, fg: string): CSSProperties => ({ flex: 'none', fontSize: 9.5, fontWeight: 600, borderRadius: 4, padding: '0 5px', lineHeight: '15px', background: bg, color: fg, whiteSpace: 'nowrap' });

  return (
    <div style={{ display: 'inline-block', verticalAlign: 'top' }} onContextMenu={(e) => { e.preventDefault(); api?.miniAction?.('menu'); }}>
      {/* 창 크기는 단계마다 고정 — 작업이 생기고 끝나도 창은 그대로, 안의 목록만 바뀐다(사용자 2026-11-13 "알림창이 점잖아야 함").
          폭은 늘 300(창 316), 높이는 카드 CARD_BOX_H · 펼침은 쓸 수 있는 최대(room) · 알약은 한 줄. 그림자 여백 8 은 mini.cjs PAD 와 같다. */}
      <div ref={boxRef} style={{
        width: 300, display: 'flex', flexDirection: 'column', height: pill ? 'auto' : size === 'card' ? Math.min(CARD_BOX_H, room - 16) : room - 16, background: c.bg, color: c.ink,
        ...(pill ? { minHeight: minH || undefined, justifyContent: 'center' } : {}),
        overflow: 'hidden', fontSize: 12, lineHeight: 1.4, userSelect: 'none',
      }}>
        {/* 머리 위 여백은 세 크기 모두 6 — 크기 단추가 화면의 같은 자리에 오게(위 구석에서는 창 위 끝이 고정이라 같은 곳을 계속 누르면 돈다) */}
        <div data-mini-head style={{ display: 'flex', flexWrap: pill ? 'nowrap' : 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4, flex: 'none', padding: pill ? '6px 8px 6px 8px' : '6px 8px 8px 11px', WebkitAppRegion: 'drag' } as any}
          title="끌어서 옮기기 · 우클릭 메뉴">
          <div title="Seedance" style={{ width: 18, height: 18, borderRadius: 5, background: 'linear-gradient(135deg,#6366f1,#0071e3)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'grid', placeItems: 'center', flex: 'none' }}>S</div>
          {!pill && <span style={{ fontSize: 12.5, fontWeight: 600, flex: 'none' }}>Seedance</span>}
          {pill
            ? <span data-mini-stat style={{ fontSize: 11.5, color: c.sub, whiteSpace: 'nowrap', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 7, height: 7, borderRadius: 7, background: dot, display: 'inline-block', flex: 'none' }} />
                <span style={{ flex: 'none' }}>{pillStat}</span>
                {running.length > 0 && <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 10.5, color: c.faint, fontFamily: 'ui-monospace, Consolas, monospace', fontVariantNumeric: 'tabular-nums' }}>{mmss(longest)}</span>}
              </span>
            : <span style={{ flex: 1 }} />}
          {/* 핀(26.11.16~, 나노바나나와 같은 자리 · 같은 뜻) — 켜짐(강조색): 구석에 붙고 다른 앱 창과 쌓임 · 꺼짐: 놓은 자리에 그대로.
              알약에는 두지 않는다(작게 유지 — 우클릭 메뉴 '구석에 고정' 으로 바꾼다). 크기 단추는 그대로 오른쪽에서 세 번째. */}
          {!pill && (
            <button style={{ ...btn, color: pinned ? c.ind : c.faint, background: pinned ? c.indSoft : 'transparent' }} data-mini-pin data-pinned={pinned ? '1' : '0'}
              title={pinned ? '구석에 고정 — 끌어 놓으면 가까운 구석에 붙고 다른 앱 창과 쌓여요 · 누르면 자유 위치' : '자유 위치 — 놓은 자리에 그대로 있어요 · 누르면 가까운 구석에 고정'}
              onClick={() => api?.miniAction?.('pin', !pinned)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </button>
          )}
          {/* 크기 단추 하나 — 누를 때마다 최대 → 카드 → 알약 → 최대(사용자 11/16 "한 부분 클릭이 모두 최대, 최소, 알약… 이렇게 바뀌어야").
              그림은 '누르면 될 모양'. 세 크기 모두 같은 자리(오른쪽에서 세 번째)라 같은 곳을 계속 누르면 된다. */}
          <button style={btn} data-mini-size data-next={NEXT_SIZE[size]} title={`크기 — 누르면 ${SIZE_LABEL[NEXT_SIZE[size]]} (최대 → 카드 → 알약 순서로 돌아요)`}
            onClick={() => api?.miniAction?.('size', NEXT_SIZE[size])}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
              {NEXT_SIZE[size] === 'pill' ? <rect x="3" y="9" width="18" height="6" rx="3" />
                : NEXT_SIZE[size] === 'full' ? <rect x="7" y="3" width="10" height="18" rx="2" />
                : <rect x="4" y="6" width="16" height="12" rx="2" />}
            </svg>
          </button>
          <button style={btn} title="본창 열기" onClick={() => api?.miniAction?.('open')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></svg>
          </button>
          <button style={btn} title={runCount || queued || waiting ? '닫기 — 지금 돌고 있는 일이 끝날 때까지는 다시 안 떠요' : '닫기'} data-mini-close onClick={() => api?.miniAction?.('close')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
          {!pill && (
            <div data-mini-stat style={{ flexBasis: '100%', display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, fontWeight: 600, color: c.ink, lineHeight: 1.35, wordBreak: 'keep-all' }}>
              <span style={{ width: 7, height: 7, borderRadius: 7, background: dot, display: 'inline-block', flex: 'none', transform: 'translateY(-1px)' }} />
              <span style={{ minWidth: 0 }}>{stat}</span>
              {running.length > 0 && <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 10.5, fontWeight: 500, color: c.faint, fontFamily: 'ui-monospace, Consolas, monospace' }} title="가장 오래 돌고 있는 작업">{mmss(longest)}</span>}
            </div>
          )}
        </div>

        {!pill && (
          <div onDoubleClick={() => api?.miniAction?.('open')} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}>
            {snap?.billing.needed && (
              noCode || waiting
                ? <div onClick={() => api?.miniAction?.('open')} style={{ flex: 'none', margin: '0 10px 8px', fontSize: 11, borderRadius: 7, padding: '5px 8px', background: c.amberSoft, color: c.amber, fontWeight: 600, cursor: 'pointer' }}>
                    프로젝트 코드가 비어 있어요{waiting ? ` — 에이전트 요청 ${waiting}건 대기` : ''} · 눌러서 고르기
                  </div>
                : <div data-clip-ok title={`프로젝트 코드 · ${snap.billing.name}`} style={{ flex: 'none', margin: '0 10px 8px', fontSize: 11, borderRadius: 7, padding: '5px 8px', background: c.chip, color: c.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>코드 · {snap.billing.name}</div>
            )}
            <div data-mini-list style={{ borderTop: `1px solid ${c.line}`, minHeight: 0, flex: '1 1 auto', overflowY: 'auto', scrollbarWidth: 'thin' } as CSSProperties}>
              {inLine > 0 && <div style={{ padding: '6px 11px', fontSize: 10.5, color: c.sub, background: c.indSoft, borderBottom: `1px solid ${c.line}` }}>MCP 요청 {inLine}건이 차례를 기다려요 — 2초에 하나씩 받아요</div>}
              {shown.length === 0 && !inLine && <div style={{ padding: '7px 11px', fontSize: 11, color: c.faint, borderBottom: `1px solid ${c.line}` }}>돌고 있는 작업이 없어요</div>}
              {shown.map((t) => {
                const cancelled = !!t.cancelled, failed = t.status === 'failed' && !cancelled, done = t.status === 'succeeded', run = t.status === 'running';
                return (
                  <div key={t.id} onClick={() => api?.miniAction?.('goto', { projectId: t.projectId, msgId: t.id })} title={`${t.prompt || '(프롬프트 없음)'}\n${t.project}${t.error ? `\n${t.error}` : ''}\n— 눌러서 그 카드로${done || failed || cancelled ? ' (확인하면 목록에서 빠져요)' : ''}`}
                    style={{ display: 'grid', gridTemplateColumns: '38px minmax(0,1fr) auto', gap: 8, alignItems: 'center', padding: '7px 10px', borderBottom: `1px solid ${c.line}`, background: failed ? c.redSoft : 'transparent', cursor: 'pointer' }}>
                    <div style={{ width: 38, height: 24, borderRadius: 4, background: c.chip, overflow: 'hidden', display: 'grid', placeItems: 'center', position: 'relative' }}>
                      {done && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={c.good} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute' }}><path d="M20 6 9 17l-5-5" /></svg>}
                      {cancelled && <svg data-mini-cancel-icon width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c.faint} strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></svg>}
                      {failed && <svg data-mini-fail-icon width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c.red} strokeWidth="2.6" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></svg>}
                      {done && t.taskId ? <img src={`/api/media/${encodeURIComponent(t.taskId)}/poster`} alt="" style={{ position: 'relative', width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : run ? <div className="animate-spin" style={{ width: 12, height: 12, borderRadius: 12, border: `2px solid ${c.indSoft}`, borderTopColor: c.ind }} /> : null}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div data-clip-ok style={{ fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: failed ? c.red : c.ink }}>{t.prompt || '(프롬프트 없음)'}</div>
                      {/* 둘째 줄은 높이 15 로 고정 — 오류 글(칩 없음)인 실패 줄만 1px 낮아 펼침 목록의 줄 높이가 들쭉날쭉했다(11/16 대조 시험).
                          모델 칩은 170 까지만 — 표에 없는 긴 모델 이름이 와도 카드 밖으로 안 나가고 끝이 '…'(마우스를 올리면 전체). */}
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginTop: 2, height: 15, fontSize: 10, color: c.faint, whiteSpace: 'nowrap', minWidth: 0 }}>
                        {failed ? <span data-clip-ok style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, lineHeight: '15px' }}>{t.error || '생성 실패'}</span> : <>
                          {t.agent && <span style={chip(c.indSoft, c.ind)}>MCP</span>}
                          <span data-clip-ok title={[t.model, t.res].filter(Boolean).join(' · ')} style={{ ...chip(t.draft ? c.amberSoft : c.chip, t.draft ? c.amber : c.sub), maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' }}>{[t.model, t.res].filter(Boolean).join(' · ')}</span>
                          <span data-clip-ok style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{t.project}</span>
                        </>}
                      </div>
                    </div>
                    <div style={{ fontSize: 10.5, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: done || failed ? 600 : 500, color: done ? c.good : failed ? c.red : cancelled ? c.faint : c.sub, fontFamily: run ? 'ui-monospace, Consolas, monospace' : undefined }}>
                      {done ? `완료 ${mmss((t.end || now) - t.start)}` : failed ? '실패' : cancelled ? '취소' : run ? mmss(now - t.start) : '대기'}
                    </div>
                  </div>
                );
              })}
              {hiddenCount > 0 && <div style={{ padding: '5px 11px', fontSize: 10.5, color: c.faint, borderBottom: `1px solid ${c.line}` }}>외 {hiddenCount}개{size === 'card' ? ' — 펼쳐서 보기' : ' — 본창에서 보기'}</div>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', flex: 'none', padding: '6px 11px 8px', fontSize: 10.5, color: c.faint }}>
              <span>오늘 <b style={{ color: c.sub, fontWeight: 600 }}>{snap?.today ?? 0}편</b>{snap?.todayFail ? ` · 실패 ${snap.todayFail}` : ''}</span>
              <span>{snap?.version ? `v${snap.version}` : ''}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
