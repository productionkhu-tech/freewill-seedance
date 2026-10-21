// 개인판의 '내 키' 화면(26.10.2005~) — 설정 패널 카드 · 위쪽 안내 띠 · 키 넣는 창.
// 값은 서버로만 간다(확인한 뒤 PC 에 암호화 저장). 화면은 저장된 값을 다시 받지 않는다 — 끝 네 글자만 보인다.
import { useEffect, useState } from 'react';
import { KeyRound, Check, ChevronDown, X } from 'lucide-react';
import { usePersonalKeyStatus, refreshPersonalKeyStatus, openPersonalKeys, onOpenPersonalKeys } from '../lib/personal-keys';

type ItemResult = { saved: boolean; ok: boolean; message: string };
type Which = 'byteplus' | 'gemini' | 'r2';

const card = 'bg-white dark:bg-[#1c1c1e] p-4 rounded-[12px] shadow-[0_3px_15px_rgba(0,0,0,0.03)] space-y-2';
const input = 'w-full px-3 py-2 text-[13px] rounded-lg border border-gray-200 dark:border-white/15 bg-white dark:bg-[#2c2c2e] text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0071e3]/40 font-mono';

function Chip({ on, label, detail }: { on: boolean; label: string; detail: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md ${on ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-white/50'}`}>
      {on ? <Check size={11} /> : null}{label}{detail ? <span className="opacity-70">{detail}</span> : null}
    </span>
  );
}

/** 설정 패널 맨 위 — 회사판의 '프로젝트 코드' 자리. */
export function PersonalKeysCard() {
  const s = usePersonalKeyStatus();
  const missing = !!s && !s.byteplus.set;
  return (
    <div className={`${card} ${missing ? 'ring-2 ring-amber-400' : ''}`} data-personal-keys-card>
      <div className="flex items-center justify-between">
        <label className="block text-[12px] font-semibold text-black/80 dark:text-white/85 tracking-[-0.12px]">내 키</label>
        <button onClick={openPersonalKeys} className="text-[11px] text-[#0071e3] dark:text-[#4da3ff] px-2 py-1 rounded-md hover:bg-[#0071e3]/10 active:scale-95 transition-all">
          {missing ? '키 넣기' : '관리'}
        </button>
      </div>
      {!s ? (
        <p className="text-[12px] text-gray-500">키 상태를 확인하는 중…</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            <Chip on={s.byteplus.set} label="BytePlus" detail={s.byteplus.set ? ` ••••${s.byteplus.tail}` : ' 필수'} />
            <Chip on={s.r2.set} label="R2" detail={s.r2.set ? ` ${s.r2.bucket}` : ' 레퍼런스용'} />
            <Chip on={s.gemini.set} label="Gemini" detail={s.gemini.set ? ` ••••${s.gemini.tail}` : ' 옴니용'} />
          </div>
          {missing && <p className="text-[11px] text-amber-600">본인 BytePlus 키를 넣어야 생성할 수 있어요.</p>}
          {!missing && !s.r2.set && <p className="text-[11px] text-black/45 dark:text-white/45">R2 가 없으면 레퍼런스 없이(텍스트 → 영상)만 보낼 수 있어요.</p>}
        </>
      )}
    </div>
  );
}

/** 화면 위쪽 띠 — 키가 없을 때 · 켤 때 키를 지웠을 때. */
export function PersonalKeyBanner() {
  const s = usePersonalKeyStatus();
  const [hideRefused, setHideRefused] = useState(false);
  if (!s) return null;
  if (s.refused && !hideRefused) {
    return (
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[85] w-[min(92%,34rem)] flex items-start gap-2.5 bg-red-50 border border-red-300 text-red-900 rounded-xl shadow-lg px-3.5 py-2.5">
        <span className="text-[13px] leading-snug flex-1 whitespace-pre-line">{s.refused}</span>
        <button onClick={openPersonalKeys} className="shrink-0 text-[12px] font-semibold text-red-700 hover:underline">키 넣기</button>
        <button onClick={() => setHideRefused(true)} className="shrink-0 text-red-400 hover:text-red-700 text-sm font-bold leading-none mt-0.5">✕</button>
      </div>
    );
  }
  if (s.byteplus.set) return null;
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[85] w-[min(92%,32rem)] flex items-center gap-2.5 bg-amber-50 border border-amber-300 text-amber-900 rounded-xl shadow-lg px-3.5 py-2.5" data-personal-key-banner>
      <KeyRound size={16} className="shrink-0 text-amber-600" />
      <span className="text-[13px] leading-snug flex-1">개인판이에요. 생성하려면 <b>본인 BytePlus 키</b>를 넣어 주세요.</span>
      <button onClick={openPersonalKeys} className="shrink-0 text-[12px] font-semibold px-2.5 py-1 rounded-lg bg-amber-500 text-white hover:bg-amber-600 active:scale-95 transition-all">키 넣기</button>
    </div>
  );
}

function Result({ r }: { r?: ItemResult }) {
  if (!r) return null;
  return <p className={`text-[11px] whitespace-pre-line ${r.ok ? 'text-emerald-600' : 'text-red-600'}`}>{r.message}</p>;
}

/** 키 넣는 창 — 앱에 하나(App.tsx). openPersonalKeys() 로 연다. */
export function PersonalKeysDialog() {
  const [open, setOpen] = useState(false);
  const s = usePersonalKeyStatus();
  const [bp, setBp] = useState('');
  const [gm, setGm] = useState('');
  const [r2, setR2] = useState({ endpoint: '', bucket: '', keyId: '', secret: '' });
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Partial<Record<Which | '_', ItemResult>>>({});

  useEffect(() => onOpenPersonalKeys(() => { setOpen(true); setResults({}); void refreshPersonalKeyStatus(); }), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);
  if (!open) return null;

  const post = async (body: unknown) => {
    setBusy(true);
    try {
      const r = await fetch('/api/personal/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      const res = (j && j.results) || {};
      setResults(r.ok ? res : { _: { saved: false, ok: false, message: j?.error || `저장하지 못했어요 (HTTP ${r.status}).` } });
      if (res.byteplus?.saved) setBp('');
      if (res.gemini?.saved) setGm('');
      if (res.r2?.saved) setR2({ endpoint: '', bucket: '', keyId: '', secret: '' });
    } catch {
      setResults({ _: { saved: false, ok: false, message: '앱 서버에 닿지 않았어요. 잠시 뒤 다시 해 주세요.' } });
    } finally {
      setBusy(false);
      void refreshPersonalKeyStatus();
    }
  };

  const save = () => {
    const body: Record<string, unknown> = {};
    if (bp.trim()) body.byteplus = bp.trim();
    if (gm.trim()) body.gemini = gm.trim();
    if ((Object.values(r2) as string[]).some(v => v.trim())) body.r2 = { endpoint: r2.endpoint.trim(), bucket: r2.bucket.trim(), keyId: r2.keyId.trim(), secret: r2.secret.trim() };
    if (!Object.keys(body).length) { setResults({ _: { saved: false, ok: false, message: '새로 넣은 키가 없어요.' } }); return; }
    void post(body);
  };
  const clear = (w: Which) => { void post({ clear: [w] }); };

  const savedLine = (on: boolean, text: string, w: Which) => on ? (
    <div className="flex items-center justify-between text-[11px] text-emerald-700 dark:text-emerald-300">
      <span className="inline-flex items-center gap-1"><Check size={11} />저장됨{text}</span>
      <button onClick={() => clear(w)} disabled={busy} className="text-gray-400 hover:text-red-500 disabled:opacity-40">지우기</button>
    </div>
  ) : null;

  return (
    <div className="fixed inset-0 z-[120] bg-black/40 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}>
      <div className="w-[min(100%,34rem)] max-h-[88vh] overflow-y-auto bg-[#f5f5f7] dark:bg-[#111113] rounded-2xl shadow-2xl p-5 space-y-4" data-personal-keys-dialog>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[17px] font-semibold text-[#1d1d1f] dark:text-white flex items-center gap-2"><KeyRound size={17} />내 키</h2>
            <p className="text-[12px] text-black/55 dark:text-white/55 mt-1 leading-relaxed">
              개인판은 본인 키로 생성해요. 요금은 각 서비스의 본인 계정으로 청구되고, 키는 이 PC 에만
              {s?.storage === 'encrypted' ? ' Windows 계정으로 암호화해' : s?.storage === 'dev-plain' ? ' (개발 실행 — 평문 파일로)' : ''} 저장돼요.
            </p>
          </div>
          <button onClick={() => !busy && setOpen(false)} className="shrink-0 text-gray-400 hover:text-gray-700 dark:hover:text-white"><X size={18} /></button>
        </div>

        <div className={card}>
          <label className="block text-[12px] font-semibold text-black/80 dark:text-white/85">BytePlus (시댄스) <span className="text-amber-600 font-normal">필수</span></label>
          {savedLine(!!s?.byteplus.set, ` ••••${s?.byteplus.tail || ''}`, 'byteplus')}
          <input type="password" autoComplete="off" spellCheck={false} value={bp} onChange={(e) => setBp(e.target.value)} placeholder={s?.byteplus.set ? '바꾸려면 새 키를 넣으세요' : 'BytePlus ModelArk API Key'} className={input} data-key-input="byteplus" />
          <p className="text-[11px] text-black/45 dark:text-white/45">BytePlus 콘솔 › ModelArk › API Key 에서 만들어요. Seedance 모델을 먼저 켜 두세요(Activate). 회사 팀 키는 넣을 수 없어요.</p>
          <Result r={results.byteplus} />
        </div>

        <div className={card}>
          <label className="block text-[12px] font-semibold text-black/80 dark:text-white/85">Cloudflare R2 <span className="text-black/40 dark:text-white/40 font-normal">선택 · 레퍼런스용</span></label>
          {savedLine(!!s?.r2.set, ` · ${s?.r2.bucket || ''} (${s?.r2.host || ''})`, 'r2')}
          <p className="text-[11px] text-black/45 dark:text-white/45">이미지 · 영상 · 오디오 레퍼런스를 BytePlus 가 가져갈 수 있게 잠깐 올려 두는 곳이에요. 없으면 텍스트 → 영상만 돼요.</p>
          <input autoComplete="off" spellCheck={false} value={r2.endpoint} onChange={(e) => setR2({ ...r2, endpoint: e.target.value })} placeholder="엔드포인트 (https://〈계정 ID〉.r2.cloudflarestorage.com)" className={input} data-key-input="r2-endpoint" />
          <input autoComplete="off" spellCheck={false} value={r2.bucket} onChange={(e) => setR2({ ...r2, bucket: e.target.value })} placeholder="버킷 이름" className={input} data-key-input="r2-bucket" />
          <input autoComplete="off" spellCheck={false} value={r2.keyId} onChange={(e) => setR2({ ...r2, keyId: e.target.value })} placeholder="액세스 키 ID" className={input} data-key-input="r2-keyid" />
          <input type="password" autoComplete="off" spellCheck={false} value={r2.secret} onChange={(e) => setR2({ ...r2, secret: e.target.value })} placeholder="비밀 액세스 키" className={input} data-key-input="r2-secret" />
          <button onClick={() => setGuide(!guide)} className="flex items-center gap-1 text-[11px] text-[#0071e3] dark:text-[#4da3ff]">
            <ChevronDown size={12} className={`transition-transform ${guide ? 'rotate-180' : ''}`} />R2 만드는 법
          </button>
          {guide && (
            <ol className="list-decimal pl-5 space-y-1 text-[11px] text-black/60 dark:text-white/60 leading-relaxed">
              <li>Cloudflare 에 가입하고 대시보드에서 <b>R2 Object Storage</b> 를 켜요. 결제 수단 등록이 필요하지만, 이 앱 사용량은 무료 구간(저장 10GB · 내려받기 무료) 안이에요.</li>
              <li><b>버킷 만들기</b> → 그 버킷의 설정 › 객체 수명 주기 규칙에 <b>'1일 뒤 삭제'</b> 를 추가해요. 앱도 생성이 끝나면 지우지만, 남는 것을 치워 줘요.</li>
              <li>R2 › <b>API 토큰 관리</b> › 토큰 만들기 — 권한은 <b>객체 읽기 및 쓰기</b>, 범위는 <b>그 버킷만</b>.</li>
              <li>만든 뒤 나오는 <b>액세스 키 ID · 비밀 액세스 키 · S3 엔드포인트</b>와 버킷 이름을 위 네 칸에 붙여 넣고 아래 '확인하고 저장' 을 눌러요. 앱이 작은 파일을 올렸다 지워 보며 확인해요.</li>
            </ol>
          )}
          <Result r={results.r2} />
        </div>

        <div className={card}>
          <label className="block text-[12px] font-semibold text-black/80 dark:text-white/85">Google Gemini <span className="text-black/40 dark:text-white/40 font-normal">선택 · 옴니용</span></label>
          {savedLine(!!s?.gemini.set, ` ••••${s?.gemini.tail || ''}`, 'gemini')}
          <input type="password" autoComplete="off" spellCheck={false} value={gm} onChange={(e) => setGm(e.target.value)} placeholder="Google AI Studio API Key" className={input} data-key-input="gemini" />
          <Result r={results.gemini} />
        </div>

        <Result r={results._} />
        <div className="flex justify-end gap-2">
          <button onClick={() => !busy && setOpen(false)} disabled={busy} className="px-3.5 py-2 text-[13px] rounded-lg text-gray-600 dark:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40">닫기</button>
          <button onClick={save} disabled={busy} className="px-3.5 py-2 text-[13px] rounded-lg bg-[#0071e3] text-white font-semibold hover:bg-[#0062c4] active:scale-95 transition-all disabled:opacity-50" data-key-save>
            {busy ? '확인하는 중…' : '확인하고 저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
