# Deploys the checked-out repository to the live app folder on the Windows
# Server VM and restarts the Windows service. Run by the GitHub Actions
# self-hosted runner on every push to master (see .github/workflows/ci-cd.yml);
# can also be run by hand from a checkout.
param(
  [string]$Source = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$AppDir = 'C:\apps\casuals-attendance-portal',
  [string]$ServiceName = 'CasualsPortal'
)

$ErrorActionPreference = 'Stop'

function Invoke-Native([string]$Label, [scriptblock]$Command) {
  Write-Host "==> $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE)" }
}

if (-not (Test-Path "$AppDir\.env")) {
  throw "$AppDir\.env not found - run deploy\windows\setup-server.ps1 and create the .env first."
}

# 1. Build in the runner workspace so a failed build never touches the live app.
Push-Location $Source
try {
  Invoke-Native 'npm ci'          { npm ci --no-audit --no-fund }
  Invoke-Native 'prisma generate' { npx prisma generate }
  Invoke-Native 'build frontend'  { npm run build }
} finally { Pop-Location }

# 2. Stop the service (Prisma's query engine is locked while it runs).
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) { throw "Windows service '$ServiceName' not found - run setup-server.ps1 first." }
Write-Host "==> Stopping $ServiceName"
Stop-Service -Name $ServiceName -Force
(Get-Service -Name $ServiceName).WaitForStatus('Stopped', '00:01:00')

try {
  # 3. Mirror the build into the app folder. .env and logs live only on the
  #    server and are excluded, so /MIR never deletes them.
  Write-Host "==> Copying files to $AppDir"
  robocopy $Source $AppDir /MIR /XD .git .github logs /XF .env *.log /NFL /NDL /NP /NJH /R:2 /W:2
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit code $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0

  # 4. Apply any new database migrations (reads DATABASE_URL from $AppDir\.env).
  Push-Location $AppDir
  try {
    Invoke-Native 'prisma migrate deploy' { npx prisma migrate deploy }
  } finally { Pop-Location }
} finally {
  # 5. Always bring the service back up, even if a step above failed.
  Write-Host "==> Starting $ServiceName"
  Start-Service -Name $ServiceName
}

# 6. Health check.
$port = 4000
$portLine = Select-String -Path "$AppDir\.env" -Pattern '^\s*PORT\s*=\s*"?(\d+)' | Select-Object -First 1
if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }

$url = "http://localhost:$port/api/health"
for ($i = 1; $i -le 30; $i++) {
  try {
    $res = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
    if ($res.StatusCode -eq 200) { Write-Host "==> Deployed - $url is healthy"; exit 0 }
  } catch { }
  Start-Sleep -Seconds 2
}
throw "Service did not become healthy at $url - check $AppDir\logs"
