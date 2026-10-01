# One-time setup of the Windows Server VM. Run once from an elevated
# PowerShell in a checkout of this repo. Prerequisite: Node.js LTS on PATH.
#
#   .\deploy\windows\setup-server.ps1 -RunnerToken <token>
#
# It:
#   1. trusts the Let's Encrypt root (ISRG Root X1) if the machine is missing
#      it — without it GitHub's download hosts and nssm.cc fail TLS checks;
#   2. installs NSSM to C:\tools\nssm if it isn't already on PATH;
#   3. creates the app folder and .env, registers the portal as a Windows
#      service and opens the firewall port;
#   4. with -RunnerToken, installs the GitHub Actions self-hosted runner as a
#      service (token from repo → Settings → Actions → Runners → New
#      self-hosted runner; valid for one hour).
# Safe to re-run: every step skips what is already in place.
param(
  [string]$AppDir = 'C:\apps\casuals-attendance-portal',
  [string]$ServiceName = 'CasualsPortal',
  [int]$Port = 4000,
  [string]$RunnerToken,
  [string]$RepoUrl = 'https://github.com/M-Jude/casuals-attendance-portal',
  [string]$RunnerDir = 'C:\actions-runner'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this script from an elevated (Run as administrator) PowerShell.' }

$node = (Get-Command node -ErrorAction Stop).Source

# 1. Let's Encrypt root. Taken from the CA list compiled into the signed
#    node.exe (Mozilla's store) and pinned by fingerprint, rather than from
#    anything downloaded.
$isrgThumbprint = 'CABD2A79A1076A31F21D253635CB039D4329A5E8'
if (-not (Test-Path "Cert:\LocalMachine\Root\$isrgThumbprint")) {
  Write-Host '==> Installing ISRG Root X1 into the machine root store'
  $pemFile = Join-Path $env:TEMP 'isrg-root-x1.pem'
  $js = "const {X509Certificate}=require('crypto');const p=require('tls').rootCertificates.find(p=>new X509Certificate(p).fingerprint.replace(/:/g,'')==='$isrgThumbprint');if(!p)process.exit(1);process.stdout.write(p)"
  $pem = & $node -e $js
  if ($LASTEXITCODE -ne 0) { throw 'ISRG Root X1 not found in Node''s CA store.' }
  Set-Content -Path $pemFile -Value $pem -Encoding ascii
  $cert = Import-Certificate -FilePath $pemFile -CertStoreLocation Cert:\LocalMachine\Root
  Remove-Item $pemFile
  if ($cert.Thumbprint -ne $isrgThumbprint) { throw 'Imported certificate fingerprint mismatch.' }
}

# 2. NSSM.
$nssmCmd = Get-Command nssm -ErrorAction SilentlyContinue
if ($nssmCmd) {
  $nssm = $nssmCmd.Source
} else {
  $nssm = 'C:\tools\nssm\nssm.exe'
  if (-not (Test-Path $nssm)) {
    Write-Host '==> Installing NSSM to C:\tools\nssm'
    $zip = Join-Path $env:TEMP 'nssm-2.24.zip'
    Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath (Join-Path $env:TEMP 'nssm') -Force
    New-Item -ItemType Directory -Force -Path 'C:\tools\nssm' | Out-Null
    Copy-Item (Join-Path $env:TEMP 'nssm\nssm-2.24\win64\nssm.exe') $nssm
    Remove-Item $zip
  }
}

# 3. App folder, .env, service, firewall.
New-Item -ItemType Directory -Force -Path $AppDir, "$AppDir\logs" | Out-Null

if (-not (Test-Path "$AppDir\.env")) {
  Copy-Item "$PSScriptRoot\..\..\.env.example" "$AppDir\.env"
  Write-Warning "Created $AppDir\.env from .env.example - fill in the real values (and PORT=$Port) before the first deploy."
}

if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
  Write-Host "==> Registering service $ServiceName"
  & $nssm install $ServiceName $node server.js
}
& $nssm set $ServiceName AppDirectory $AppDir | Out-Null
& $nssm set $ServiceName AppEnvironmentExtra NODE_ENV=production | Out-Null
& $nssm set $ServiceName AppStdout "$AppDir\logs\portal.out.log" | Out-Null
& $nssm set $ServiceName AppStderr "$AppDir\logs\portal.err.log" | Out-Null
& $nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
& $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null

if (-not (Get-NetFirewallRule -DisplayName "Casuals Portal ($Port)" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "Casuals Portal ($Port)" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
}

# 4. GitHub Actions runner. Runs as LocalSystem so the deploy job can stop
#    and start the portal service.
if ($RunnerToken) {
  if (Test-Path "$RunnerDir\.runner") {
    Write-Host "==> Runner already configured in $RunnerDir - skipping"
  } else {
    Write-Host "==> Installing GitHub Actions runner to $RunnerDir"
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/actions/runner/releases/latest' -UseBasicParsing
    $asset = $release.assets | Where-Object { $_.name -like 'actions-runner-win-x64-*.zip' } | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path $RunnerDir | Out-Null
    $zip = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $RunnerDir -Force
    Remove-Item $zip
    Push-Location $RunnerDir
    try {
      & .\config.cmd --unattended --url $RepoUrl --token $RunnerToken --name $env:COMPUTERNAME `
        --labels casuals-portal --work _work --runasservice --windowslogonaccount 'NT AUTHORITY\SYSTEM'
      if ($LASTEXITCODE -ne 0) { throw "Runner configuration failed (exit code $LASTEXITCODE)" }
    } finally { Pop-Location }
  }
} else {
  Write-Warning 'No -RunnerToken given - the GitHub Actions runner was not installed. Re-run with -RunnerToken to add it.'
}

Write-Host "Done. Service '$ServiceName' is registered for $AppDir; the first push to master will deploy and start it."
