import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import './index.css';

// 미니 창(?mini=1, electron/mini.cjs)은 App · 스토어를 아예 들이지 않는다 — 같은 기록(IndexedDB)을 두 창이 쓰면
// 저장이 엉킨다. 미니 창은 본창이 보내는 요약만 그린다.
const isMini = new URLSearchParams(location.search).has('mini');
const root = createRoot(document.getElementById('root')!);
if (isMini) {
  import('./mini/MiniApp').then(({default: MiniApp}) => root.render(<StrictMode><MiniApp /></StrictMode>));
} else {
  import('./App.tsx').then(({default: App}) => root.render(<StrictMode><App /></StrictMode>));
}
