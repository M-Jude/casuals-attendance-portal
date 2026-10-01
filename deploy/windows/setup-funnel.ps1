# Publishes the portal on the internet with Tailscale Funnel: Tailscale runs
# as a Windows service, connects OUT to Tailscale (no inbound firewall rule,
# port forward or domain needed) and serves the portal over HTTPS at
#   https://<machine-name>.<your-tailnet>.ts.net
#
# Run once from an elevated PowerShell:
#
#   .\deploy\windows\setup-funnel.ps1 -AuthKey <tskey-auth-...>
#
# Auth key: Tailscale admin console → Settings → Keys → Generate auth key
# (one-off use is fine). Without -AuthKey the script prints a login link
# instead. The first time Funnel is used, Tailscale may print a link to
# enable it for your tailnet — open it, approve, and the script continues.
# Safe to re-run. Also removes the Cloudflare Tunnel service if present.
param(
  [string]$AuthKey,
  [string]$AppDir = 'C:\apps\casuals-attendance-portal'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # PowerShell 5.1 downloads crawl with the progress bar on
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this script from an elevated (Run as administrator) PowerShell.' }

function Invoke-Native([string]$Label, [scriptblock]$Command) {
  Write-Host "==> $Label"
  $ErrorActionPreference = 'Continue'
  & $Command 2>&1 | ForEach-Object { Write-Host "$_" }
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE)" }
}

# The portal's port, from the app's .env (default 4000, as in server.js).
$port = 4000
$portLine = Select-String -Path "$AppDir\.env" -Pattern '^\s*PORT\s*=\s*"?(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }

# 1. Install Tailscale (unattended mode: stays connected with nobody logged in).
$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path $tailscale)) {
  $msi = Join-Path $env:TEMP 'tailscale-setup.msi'
  Write-Host '==> Downloading Tailscale'
  for ($attempt = 1; ; $attempt++) {
    try {
      Invoke-WebRequest -Uri 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile $msi -UseBasicParsing
      break
    } catch {
      if ($attempt -ge 5) { throw "Downloading Tailscale failed after $attempt attempts: $($_.Exception.Message)" }
      Write-Host "    download interrupted - retrying ($attempt/5)"
      Start-Sleep -Seconds 5
    }
  }
  $sig = Get-AuthenticodeSignature $msi
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Tailscale') {
    Remove-Item $msi
    throw "Tailscale installer signature check failed ($($sig.Status)) - not installing."
  }
  Write-Host '==> Installing Tailscale'
  $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/quiet', '/norestart', 'TS_UNATTENDEDMODE=always' -Wait -PassThru
  Remove-Item $msi
  if ($p.ExitCode -notin 0, 3010) { throw "Tailscale install failed (msiexec exit code $($p.ExitCode))" }
  for ($i = 0; $i -lt 30 -and -not (Test-Path $tailscale); $i++) { Start-Sleep -Seconds 1 }
}

# 2. Join the tailnet.
$upArgs = @('up', '--unattended')
if ($AuthKey) { $upArgs += "--auth-key=$AuthKey" }
Invoke-Native 'Connecting to Tailscale (follow the login link if one is shown)' { & $tailscale @upArgs }

# 3. Publish the portal on the public internet over HTTPS (persists across
#    reboots). Tailscale proxies https://<name>.ts.net -> localhost:<port>.
Invoke-Native "Enabling Funnel for localhost:$port" { & $tailscale funnel --bg $port }

# 4. The Cloudflare Tunnel is no longer used.
$cloudflared = 'C:\tools\cloudflared\cloudflared.exe'
if ((Get-Service -Name Cloudflared -ErrorAction SilentlyContinue) -and (Test-Path $cloudflared)) {
  Invoke-Native 'Removing the Cloudflare Tunnel service' { & $cloudflared service uninstall }
}

$dnsName = ((& $tailscale status --json | Out-String | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
Write-Host ''
Write-Host "Done. The portal is public at:  https://$dnsName"
Write-Host "Set APP_BASE_URL=`"https://$dnsName`" in $AppDir\.env and restart the CasualsPortal service."
