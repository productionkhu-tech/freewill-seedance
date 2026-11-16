// '미니 창으로' 단추(electron/mini.cjs). 26.11.17~ 오른쪽 위 Settings 머리줄 끝 — 사용자 "세팅 옆 우측 상단이 나을 듯.
// 지금 좌측에 다 보니까 좌측이 너무 좁음". 26.11.16(1602)에는 왼쪽 사이드바 아래 ON/OFF 였다.
// 미니 창은 본창 **대신** 뜬다(26.11.17~ 사용자 "미니창을 띄우면 본창은 없고, 미니창에서 본창 띄우면 미니창은 사라지고") — 누르면 본창은
// 트레이로 숨고 화면 구석에 미니 창만 남는다. 그래서 본창에서 보면 늘 '꺼진' 상태라 ON/OFF 대신 '미니 창으로' 라는 행동 이름을 단다.
// 돌아오는 길: 미니 창의 ↗ · 줄 누르기 · 트레이 'Open'. 트레이 메뉴 '미니 창' 과 같은 스위치다(mini:toggle).
// 웹으로 띄운 화면(맥 소스 실행 · 브라우저)에는 미니 창이 없어 단추도 없다.
import { useEffect, useState } from 'react';
import { PictureInPicture2 } from 'lucide-react';

// compact: 나눠 보기 중이면 같은 머리줄에 '어느 칸' 배지가 같이 서서(패널 폭 320) 글자를 빼고 그림만 — 배지 이름이 덜 잘리게.
export function MiniToggle({ compact = false }: { compact?: boolean }) {
  const api = (window as any).electronAPI;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!api?.miniToggle) return;
    api.miniVisible?.().then((v: boolean) => setOn(!!v)).catch(() => {});
    return api.onMiniVisible?.((v: boolean) => setOn(!!v));
  }, [api]);
  if (!api?.miniToggle) return null;
  return (
    <button type="button" onClick={() => api.miniToggle()} data-mini-toggle aria-pressed={on}
      title={'미니 창으로 — 본창은 트레이로 숨고, 화면 구석에 지금 돌고 있는 작업만 남습니다.\n미니 창의 ↗(본창 열기) · 줄 누르기 · 트레이 \'Open\' 으로 본창에 돌아옵니다.'}
      className={`shrink-0 flex items-center gap-1.5 h-7 ${compact ? 'px-2' : 'pl-2 pr-2.5'} rounded-full border text-[12px] font-medium transition-colors active:scale-[0.97] ${on
        ? 'bg-[#0071e3]/10 border-[#0071e3]/30 text-[#0071e3] dark:bg-[#5aa9ff]/15 dark:border-[#5aa9ff]/35 dark:text-[#5aa9ff]'
        : 'bg-white dark:bg-[#1c1c1e] border-black/10 dark:border-white/10 text-black/60 dark:text-white/60 hover:text-black/85 dark:hover:text-white/90'}`}>
      <PictureInPicture2 size={14} />
      {!compact && <span>미니 창으로</span>}
    </button>
  );
}
