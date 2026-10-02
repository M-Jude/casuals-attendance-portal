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

# Windows PowerShell turns anything a native tool writes to stderr into an
# error record, which 'Stop' makes fatal - and npm writes routine warnings
# there. So run native tools with 'Continue', print their stderr as plain
# text, and judge success by exit code alone.
function Invoke-Native([string]$Label, [scriptblock]$Command) {
  Write-Host "==> $Label"
  $ErrorActionPreference = 'Continue'
  & $Command 2>&1 | ForEach-Object { Write-Host "$_" }
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE)" }
}

if (-not (Test-Path "$AppDir\.env")) {
  throw "$AppDir\.env not found - run deploy\windows\setup-server.ps1 and create the .env first."
}

# Keep a copy of every deploy's output on the server (last 20 runs).
Start-Transcript -Path "$AppDir\logs\deploy-$(Get-Date -Format 'yyyyMMdd-HHmmss').log" | Out-Null
Get-ChildItem "$AppDir\logs\deploy-*.log" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 | Remove-Item

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

  # Which version is live, for the System status page. GITHUB_* are set by
  # Actions; a hand-run deploy records "manual".
  $version = [ordered]@{
    commit     = $(if ($env:GITHUB_SHA) { $env:GITHUB_SHA } else { 'manual' })
    ref        = $(if ($env:GITHUB_REF_NAME) { $env:GITHUB_REF_NAME } else { $null })
    runUrl     = $(if ($env:GITHUB_RUN_ID) { "$env:GITHUB_SERVER_URL/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID" } else { $null })
    deployedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  [IO.File]::WriteAllText("$AppDir\version.json", ($version | ConvertTo-Json))

  # 4. Apply any new database migrations. With MIGRATE_DATABASE_URL in .env
  #    they run as the migration user, and the portal's own limited user
  #    (DATABASE_URL) then gets its table permissions refreshed and checked
  #    — read + add only on the audit log (scripts/dbGrants.js). Without
  #    it, migrations run as DATABASE_URL, as before. The URL is never
  #    printed (this output is kept in the deploy log).
  $migrateLine = Select-String -Path "$AppDir\.env" -Pattern '^\s*MIGRATE_DATABASE_URL\s*=\s*"?([^"\r\n]+)"?' | Select-Object -First 1
  Push-Location $AppDir
  try {
    if ($migrateLine) {
      $env:DATABASE_URL = $migrateLine.Matches[0].Groups[1].Value.Trim()
      try {
        Invoke-Native 'prisma migrate deploy (as the migration user)' { npx prisma migrate deploy }
      } finally { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
      Invoke-Native 'database permissions for the portal user' { node scripts/dbGrants.js --apply }
    } else {
      Write-Warning 'MIGRATE_DATABASE_URL is not set: migrations run as DATABASE_URL and the audit log is not protected at database level. See "Database users" in the README.'
      Invoke-Native 'prisma migrate deploy' { npx prisma migrate deploy }
    }
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
