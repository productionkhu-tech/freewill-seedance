# 시댄스 키 확인 — 이 PC 에 깔린 시댄스 관련 키를 '값 없이' 보여 준다. 아무것도 바꾸지 않는다(읽기만).
# 같은 폴더의 '시댄스 키 확인.bat' 을 두 번 눌러 실행한다. 원본: 앱 저장소 scripts/key-check/
#   - 키 값은 화면에 절대 안 찍는다. 시댄스 키는 '어느 팀 키인지' 만 게이트웨이에 물어 보여 준다
#     (보내는 건 입장권 = HMAC(키, 'seedance-ticket-v1') — 키 원문이 아니다). 지문은 관리 화면 '키 지문' 과 같은 sha256 앞 8자.
#   - '앱이 쓰는 팀' 은 앱(26.10.802~)이 남기는 key-status.json 에서 읽는다(값 없는 파일).
# ★ 이 파일은 UTF-8(BOM) 으로 저장할 것 — BOM 이 없으면 Windows PowerShell 5.1 이 한글을 깨뜨려 문법 오류가 난다.
$ErrorActionPreference = 'SilentlyContinue'
$Gateway = 'https://seedance-gateway.production-khu.workers.dev'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

function Hex([byte[]]$b) { ($b | ForEach-Object { $_.ToString('x2') }) -join '' }
function Get-Env([string]$name) {
  $u = [Environment]::GetEnvironmentVariable($name, 'User')
  if ($u) { return @{ v = $u; where = '' } }
  $m = [Environment]::GetEnvironmentVariable($name, 'Machine')
  if ($m) { return @{ v = $m; where = ' (PC 전체 환경변수)' } }
  return $null
}
function Get-Fp([string]$s) {
  $sha = [Security.Cryptography.SHA256]::Create()
  (Hex $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s))).Substring(0, 8)
}
function Get-TeamOf([string]$key) {
  $h = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($key))
  $ticket = Hex $h.ComputeHash([Text.Encoding]::UTF8.GetBytes('seedance-ticket-v1'))
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$Gateway/v1/ticket" -ContentType 'application/json' -Body ('{"ticket":"' + $ticket + '"}') -TimeoutSec 10
    if ($r.ok) { return @{ label = [string]$r.label; text = "$($r.label) 키" } }
  } catch {
    $code = 0
    try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    if ($code -eq 404) { return @{ label = ''; text = '등록된 팀 키가 아님' } }
    return @{ label = ''; text = '팀 확인 못 함 (인터넷 연결 확인)' }
  }
  return @{ label = ''; text = '팀 확인 못 함' }
}
# 한글은 두 칸을 차지한다 — 글자 수가 아니라 화면 너비로 맞춘다.
function Pad([string]$s, [int]$w) {
  $n = 0
  foreach ($ch in $s.ToCharArray()) { if ([int]$ch -ge 0x1100) { $n += 2 } else { $n += 1 } }
  return $s + (' ' * [Math]::Max(1, $w - $n))
}
function Show([string]$name, [string]$state, [string]$color = 'Gray') {
  Write-Host ('  ' + (Pad $name 25)) -NoNewline
  Write-Host $state -ForegroundColor $color
}
function When($t) { try { return ([datetime]$t).ToString('yyyy-MM-dd HH:mm') } catch { return '' } }

$who = "$env:USERNAME@$env:COMPUTERNAME"
Write-Host ''
Write-Host '  ==========================================================' -ForegroundColor DarkGray
Write-Host '   시댄스 키 확인        (키 값은 화면에 나오지 않습니다)' -ForegroundColor White
Write-Host '  ==========================================================' -ForegroundColor DarkGray
Write-Host "  PC          : $who" -NoNewline
Write-Host '   <- 관리 화면의 PC 이름' -ForegroundColor DarkGray
Write-Host "  확인 시각   : $((Get-Date).ToString('yyyy-MM-dd HH:mm'))"

# ── 앱 ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '[시댄스 앱]' -ForegroundColor Cyan
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Freewill Seedance 2.0\Freewill Seedance 2.0.exe'
$appTeam = ''
if (Test-Path $exe) {
  $ver = ((Get-Item $exe).VersionInfo.ProductVersion) -replace '\.0$', ''
  $isOn = Get-Process -Name 'Freewill Seedance 2.0' -ErrorAction SilentlyContinue
  if ($isOn) { $running = '켜져 있음' } else { $running = '꺼져 있음' }
  Show '설치된 버전' "$ver  ($running)"
} else {
  Show '설치된 버전' '설치 안 됨' 'Yellow'
}
$ud = Join-Path $env:APPDATA 'freewill-seedance'
$statusFile = Join-Path $ud 'key-status.json'
if (Test-Path $statusFile) {
  $st = Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
  switch ($st.mode) {
    'gateway' { $how = '게이트웨이에서 받음' }
    'cache'   { $how = '보관해 둔 키로 켬 (게이트웨이 확인 중)' }
    'offline' { $how = '게이트웨이에 못 닿아 bat 키로 씀' }
    'revoked' { $how = '관리자가 이 PC 를 끊음 — 관리자에게 문의' }
    default   { $how = '게이트웨이 안 씀' }
  }
  $appTeam = [string]$st.label
  if ($appTeam) { $teamText = $appTeam } else { $teamText = '(모름)' }
  if ($st.mode -eq 'revoked') { $color = 'Red' } elseif ($st.mode -eq 'gateway' -or $st.mode -eq 'cache') { $color = 'Green' } else { $color = 'Yellow' }
  if ($st.switched) { $extra = ' · 이번에 팀 bat 이 바뀌어 다시 등록함' } else { $extra = '' }
  Show '앱이 쓰는 팀' "$teamText — $how ($(When $st.at), 앱 $($st.app))$extra" $color
} else {
  Show '앱이 쓰는 팀' '알 수 없음 — 앱 26.10.802 이상을 한 번 켜면 보입니다' 'DarkGray'
}
$vault = Join-Path $ud 'secrets.bin'
if (Test-Path $vault) { Show '암호 파일' "있음 (마지막 저장 $(When (Get-Item $vault).LastWriteTime))" 'Green' }
else { Show '암호 파일' '없음 — 앱 26.10.802 이상을 켜면 생깁니다' 'DarkGray' }

# ── 환경변수 ───────────────────────────────────────────────────────
Write-Host ''
Write-Host '[환경변수 — 팀 bat 이 심는 곳]' -ForegroundColor Cyan
$sd = Get-Env 'SEEDANCE_API_KEY'
$batTeam = ''
if ($sd) {
  $t = Get-TeamOf $sd.v
  $batTeam = $t.label
  Show 'SEEDANCE_API_KEY' "있음 — $($t.text) (지문 $(Get-Fp $sd.v))$($sd.where)" 'Yellow'
} else {
  Show 'SEEDANCE_API_KEY' '없음' 'Green'
}
foreach ($n in 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET') {
  $e = Get-Env $n
  if ($e) { Show $n "있음$($e.where)" 'Yellow' } else { Show $n '없음' 'Green' }
}
$nb = Get-Env 'NANOBANANA_STUDIO_KEY'
if (-not $nb) { Show 'NANOBANANA_STUDIO_KEY' '없음 (나노바나나 앱용)' 'Gray' }
elseif ($nb.v -eq 'managed-by-gateway') { Show 'NANOBANANA_STUDIO_KEY' '나노바나나 게이트웨이 표시값 (정상 — 나노바나나가 관리)' 'Gray' }
else { Show 'NANOBANANA_STUDIO_KEY' "있음 (나노바나나 앱용 — 시댄스는 안 지움)$($nb.where)" 'Gray' }
$oldNames = 'SEEDANCE_25_DEMO_KEY', 'SEEDANCE_25_DEMO_ENDPOINT', 'NCP_OBJECT_ACCESS_KEY_ID', 'NCP_OBJECT_SECRET_ACCESS_KEY', 'NCP_OBJECT_BUCKET', 'NCP_OBJECT_ENDPOINT', 'NCP_OBJECT_REGION', 'NCP_PRESIGN_EXPIRES_SECONDS'
$old = @($oldNames | Where-Object { Get-Env $_ })
if ($old.Count -gt 0) { Show '옛 키 (2.5 데모, NCP)' ('남아 있음: ' + ($old -join ', ') + ' — 앱을 켜면 지웁니다') 'Yellow' }
else { Show '옛 키 (2.5 데모, NCP)' '없음' 'Green' }

# ── 읽는 법 ────────────────────────────────────────────────────────
Write-Host ''
Write-Host '[읽는 법]' -ForegroundColor Cyan
if ($sd) {
  if ($appTeam -and $batTeam -and ($appTeam -ne $batTeam)) {
    Write-Host "  · 깔린 bat 은 $batTeam 키입니다. 앱을 완전히 끄고(트레이 아이콘 → Quit) 다시 켜면 $batTeam 으로 바뀌고," -ForegroundColor Yellow
    Write-Host '    환경변수의 키는 암호 파일로 옮겨진 뒤 지워집니다.' -ForegroundColor Yellow
  } else {
    Write-Host '  · 환경변수에 시댄스 키가 있습니다 — 팀 bat 을 막 돌렸거나 앱이 26.10.801 이하입니다.' -ForegroundColor Yellow
    Write-Host '    앱(26.10.802 이상)을 완전히 끄고(트레이 아이콘 → Quit) 다시 켜면 암호 파일로 옮기고 지웁니다.' -ForegroundColor Yellow
  }
} elseif (Test-Path $vault) {
  Write-Host '  · 정상 — 키는 이 PC 만 여는 암호 파일에 있고, 환경변수에는 없습니다.' -ForegroundColor Green
} else {
  Write-Host '  · 시댄스 키가 없습니다 — 팀 bat 을 실행한 뒤 시작 메뉴에서 앱을 켜세요.' -ForegroundColor Yellow
}
Write-Host '  · 팀을 바꾸려면: 그 팀 bat 실행 → 앱을 완전히 끄고 다시 켜기. 관리자가 키를 바꾸면 앱을 켤 때 저절로 받습니다.' -ForegroundColor DarkGray
Write-Host ''
