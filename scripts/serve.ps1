# 法眼 LegalEye 本機啟動程式（不需安裝 Node.js）
# 以 Windows 內建 PowerShell 提供 dist 資料夾的靜態網頁，只接受本機（localhost）連線。
# 用法：雙擊專案根目錄的「啟動法眼.bat」，或執行 powershell -ExecutionPolicy Bypass -File scripts\serve.ps1
param(
  [int]$Port = 8765,
  [string]$Root = (Join-Path $PSScriptRoot '..\dist'),
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path
if (-not (Test-Path (Join-Path $Root 'index.html'))) {
  Write-Host "找不到 $Root\index.html。請確認 dist 資料夾存在（由 npm run build 產生）。" -ForegroundColor Red
  Read-Host '按 Enter 結束'
  exit 1
}

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.wasm' = 'application/wasm'
  '.gz' = 'application/octet-stream'; '.bcmap' = 'application/octet-stream'; '.pfb' = 'application/octet-stream'; '.ttf' = 'font/ttf'
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch {
  Write-Host "無法使用連接埠 $Port（可能已被佔用）。可改用：scripts\serve.ps1 -Port 8766" -ForegroundColor Red
  Read-Host '按 Enter 結束'
  exit 1
}
Write-Host "法眼 LegalEye 已啟動：$prefix" -ForegroundColor Green
Write-Host '關閉此視窗即停止服務。文件只在你的瀏覽器中處理，本程式不會保存任何資料。'
if (-not $NoBrowser) { Start-Process $prefix }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $full = [IO.Path]::GetFullPath((Join-Path $Root $rel))
    # 防止路徑穿越：只允許 dist 內的檔案
    if (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $full -PathType Leaf)) {
      $res.StatusCode = 404
    } else {
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $res.Headers.Add('X-Content-Type-Options', 'nosniff')
      $res.Headers.Add('Cache-Control', 'no-cache')
      $bytes = [IO.File]::ReadAllBytes($full)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch {
    $res.StatusCode = 500
  } finally {
    $res.Close()
  }
}
