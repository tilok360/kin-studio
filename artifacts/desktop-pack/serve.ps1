$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8765
$url = "http://127.0.0.1:$port/phone.html"

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $chrome) {
  Write-Host "Google Chrome was not found. Install Chrome, then run this again."
  exit 1
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
try {
  $listener.Start()
} catch {
  Write-Host "Could not start Kin Studio on port $port."
  Write-Host $_.Exception.Message
  exit 1
}

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json'
  '.wasm' = 'application/wasm'
  '.onnx' = 'application/octet-stream'
  '.bin'  = 'application/octet-stream'
  '.woff2'= 'font/woff2'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.webmanifest' = 'application/manifest+json'
}

Start-Process $chrome "--app=$url"
Write-Host "Kin Studio is open in Chrome. Leave this window open while you use it."

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'phone.html' }
    $rel = $rel -replace '/', '\'
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
    $rootFull = [System.IO.Path]::GetFullPath($root)
    if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $ctx.Response.StatusCode = 404
      $buf = [Text.Encoding]::UTF8.GetBytes('Not found')
      $ctx.Response.OutputStream.Write($buf, 0, $buf.Length)
    } else {
      $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      $ctx.Response.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' })
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch {
    try { $ctx.Response.StatusCode = 500 } catch {}
  } finally {
    try { $ctx.Response.OutputStream.Close() } catch {}
  }
}
