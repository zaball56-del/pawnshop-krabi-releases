$ErrorActionPreference = 'Stop'

Write-Host '=== สร้างโปรแกรมสถานธนานุบาลเทศบาลเมืองกระบี่สำหรับ Windows 11 ===' -ForegroundColor Green

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  throw 'ไม่พบ Node.js / npm กรุณาติดตั้ง Node.js 24 LTS ก่อน'
}

$nodeVersion = (& node -p "process.versions.node").Trim()
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 22) {
  throw "Node.js เวอร์ชัน $nodeVersion เก่าเกินไป กรุณาใช้ Node.js 24"
}

if (-not (Test-Path 'node_modules')) {
  npm install
  if ($LASTEXITCODE -ne 0) { throw 'ติดตั้ง dependencies ไม่สำเร็จ' }
}

npm run check
if ($LASTEXITCODE -ne 0) { throw 'ตรวจโครงสร้าง/ไวยากรณ์ไม่ผ่าน' }

npm run dist:win
if ($LASTEXITCODE -ne 0) { throw 'Build โปรแกรมไม่สำเร็จ' }

Write-Host ''
Write-Host 'Build เสร็จแล้ว ตรวจไฟล์ติดตั้งในโฟลเดอร์ dist' -ForegroundColor Green
Get-ChildItem '.\dist\*.exe' | Select-Object FullName, Length, LastWriteTime
