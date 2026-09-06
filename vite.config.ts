import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';
import pkg from './package.json';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      // 화면에 찍히는 앱 버전. 예전엔 App.tsx 에 문자열로 박아뒀는데 아무도 올리지
      // 않아서 26.9.104 에 멈춰 있었다 — 자동 업데이트는 멀쩡히 도는데 화면만 옛
      // 버전을 보여주니, 팀 전체가 '업데이트가 안 된다' 고 믿었다. 빌드 때 넣으면
      // 어긋날 수가 없다.
      __APP_VERSION__: JSON.stringify(pkg.version),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
