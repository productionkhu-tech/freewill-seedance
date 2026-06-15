#!/bin/bash
# Freewill Seedance 2.0 — Mac 실행 스크립트 (더블클릭)
# Windows의 start.bat에 대응. 서버를 띄우고 브라우저를 엽니다.

cd "$(dirname "$0")"

echo ""
echo "  ========================================"
echo "    Freewill Seedance 2.0 (Mac / 웹앱)"
echo "  ========================================"
echo ""

# 1) Node.js 확인
if ! command -v node >/dev/null 2>&1; then
  echo "  [오류] Node.js가 설치되어 있지 않습니다."
  echo "         https://nodejs.org 에서 LTS 버전 설치 후 다시 실행하세요."
  echo ""
  read -p "  엔터를 누르면 종료합니다..."
  exit 1
fi

# 2) .env 확인 (API 키 / R2 자격증명)
if [ ! -f ".env" ]; then
  echo "  [오류] .env 파일이 없습니다."
  echo "         맥_실행_가이드.md 의 '.env 파일 만들기'를 먼저 진행하세요."
  echo ""
  read -p "  엔터를 누르면 종료합니다..."
  exit 1
fi

# 3) 의존성 설치 (최초 1회)
if [ ! -d "node_modules" ]; then
  echo "  [설치] 의존성 설치 중... (1~2분, 최초 1회만)"
  npm install
  echo ""
fi

echo "  [실행] 서버 시작 + 브라우저 자동 열기"
echo "         종료하려면 이 창에서 Control+C"
echo ""

# 서버가 뜬 뒤 기본 브라우저로 열기 (백그라운드)
( sleep 4 && open http://localhost:3000 ) &

# 개발 서버 실행 (Vite + Express, .env 자동 로드)
npm run dev
