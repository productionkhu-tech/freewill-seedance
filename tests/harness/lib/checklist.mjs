// 실제로 났던 사고를 '바뀐 줄에서 알아볼 수 있는 것' 만 골라 묻는다(글: 걸리는 항목만). 막지는 않는다 — 사람이 읽고 답한다.
// 새 항목은 같은 일이 두 번 났을 때만, 그리고 바뀐 줄에서 알아볼 수 있을 때만 넣는다. 안 쓰이면 뺀다.
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './app.mjs';

const ITEMS = [
  { id: '설치본에 새 파일', when: (f) => f.some((x) => /^electron\/[\w-]+\.cjs$/.test(x)), ask: (f) => {
    const yml = fs.readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
    const miss = f.filter((x) => /^electron\/[\w-]+\.cjs$/.test(x) && !yml.includes(x));
    return miss.length ? `electron-builder.yml 에 없는 파일: ${miss.join(', ')} — 설치본이 켜지자마자 죽는다` : '';
  } },
  { id: 'PC 에 남기는 것', when: (f, d) => /^\+.*localStorage\.setItem|^\+.*indexedDB\.open/m.test(d), ask: (f, d) => `새로 PC 에 남기는 줄 ${(d.match(/^\+.*localStorage\.setItem/gm) || []).length}개 — 무엇을 얼마나 남기는지 사용자에게 말했나 · 캐시 정리와 같이 지워지나(11/25)` },
  { id: '되풀이 호출', when: (f, d) => /^\+.*setInterval\(/m.test(d), ask: (f, d) => `setInterval ${(d.match(/^\+.*setInterval\([^\n]*/gm) || []).map((x) => (x.match(/,\s*([^)]+)\)/) || [])[1]).filter(Boolean).join(' / ')} — 워커를 부르면 PC 수 × 하루 횟수를 셌나(11/25)` },
  { id: '게이트웨이', when: (f) => f.some((x) => x.startsWith('worker/')), ask: () => '배포 직전에 라이브 판과 저장소가 같은지 대조했나 — 배포는 통째로 바꾼다(11/4 리포트 Worker)' },
  { id: '개인판', when: (f, d) => /^\+.*(방패|인증|등록)/m.test(d) && f.some((x) => x === 'src/lib/translate-error.ts'), ask: () => '개인판에 없는 기능을 안내하지 않나(translate-error 는 판을 가르지 않는다)' },
  { id: '에이전트 설명서', when: (f) => f.includes('src/lib/send-request.ts') && !f.includes('src/lib/agent-inbox.ts'), ask: () => '보내는 동작이 바뀌었는데 agent-inbox 의 RULES 는 그대로다' },
  { id: '버전', when: (f, d) => /^\+\s*"version":/m.test(d), ask: (f, d) => (/"version":\s*"\d+\.\d+\.0\d/.test(d) ? '버전 앞자리 0 — 설치본이 켜지다 죽는다' : '') },
  { id: '상수 화면 색', when: (f, d) => /^\+.*dark:(text|bg|border)-(gray|emerald|amber|red|blue|green)-/m.test(d), ask: () => '다크에서 색 단계가 뒤집힌다(index.css 맨 위) — dark: 색을 덧붙이면 오히려 어두워진다(11/24)' },
];
export function checklist(files, diff) {
  return ITEMS.filter((x) => { try { return x.when(files, diff); } catch { return false; } }).map((x) => ({ id: x.id, text: x.ask(files, diff) })).filter((x) => x.text);
}
