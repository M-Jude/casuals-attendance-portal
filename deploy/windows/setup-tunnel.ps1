# Publishes the portal on the internet through a Cloudflare Tunnel: a
# Windows service (cloudflared) that connects OUT to Cloudflare, so no
# inbound firewall rule, port forward or public IP is needed. Cloudflare
# serves the public HTTPS address and forwards requests to the portal.
#
# Run once from an elevated PowerShell:
#
#   .\deploy\windows\setup-tunnel.ps1 -Token <tunnel token>
#
# Get the token from the Cloudflare dashboard: Zero Trust → Networks →
# Tunnels → Create a tunnel → Cloudflared → copy the token from the install
# command shown. Then, on the tunnel's "Public Hostname" tab, add your
# hostname (e.g. portal.example.com) with service type HTTP and URL
# localhost:<PORT from .env>. Safe to re-run; -Token replaces the old one.
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$InstallDir = 'C:\tools\cloudflared'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this script from an elevated (Run as administrator) PowerShell.' }

$exe = Join-Path $InstallDir 'cloudflared.exe'
if (-not (Test-Path $exe)) {
  Write-Host "==> Downloading cloudflared to $InstallDir"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  # Large GitHub downloads are sometimes reset mid-transfer on this network,
  # so retry; the signature check below rejects any truncated file.
  for ($attempt = 1; ; $attempt++) {
    try {
      Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe -UseBasicParsing
      break
    } catch {
      if ($attempt -ge 5) { throw "Downloading cloudflared failed after $attempt attempts: $($_.Exception.Message)" }
      Write-Host "    download interrupted ($($_.Exception.Message)) - retrying ($attempt/5)"
      Start-Sleep -Seconds 5
    }
  }
  $sig = Get-AuthenticodeSignature $exe
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Cloudflare') {
    Remove-Item $exe
    throw "cloudflared.exe signature check failed ($($sig.Status)) - not installing."
  }
}

# A re-run with a new token replaces the existing service.
if (Get-Service -Name Cloudflared -ErrorAction SilentlyContinue) {
  Write-Host '==> Removing the existing cloudflared service'
  & $exe service uninstall
  Start-Sleep -Seconds 3
}

Write-Host '==> Installing the cloudflared service'
& $exe service install $Token
if ($LASTEXITCODE -ne 0) { throw "cloudflared service install failed (exit code $LASTEXITCODE)" }

(Get-Service -Name Cloudflared).WaitForStatus('Running', '00:00:30')
Write-Host 'Done. The tunnel is running; the portal is reachable at the public hostname set in the Cloudflare dashboard.'
