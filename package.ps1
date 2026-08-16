# lassoDraw を .ccx にパッケージする
#
# .ccx は plugin のファイル一式を manifest.json がルートに来るように固めた ZIP。
# 配布物に不要なもの（check/ .git/ dist/ など）を巻き込まないよう、
# 含めるファイルを明示的に列挙している。
#
#   powershell -ExecutionPolicy Bypass -File package.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json

# UXP Developer Tool と同じ命名規則 (<id>_<app>.ccx)
$hosts = @($manifest.host)
$app = $hosts[0].app
$pkgName = "$($manifest.id)_$app.ccx"

# manifest の必須項目チェック（UDT の PluginPackageCommand.validateForPackaging 相当）。
# ここを満たしていないと Creative Cloud のインストールがエラーコード -4 で落ちる。
if (-not $manifest.version -or ($manifest.version -split '\.').Count -ne 3) {
    throw 'manifest.version は "x.y.z" 形式である必要があります'
}
if ([int]$manifest.manifestVersion -lt 4) { throw 'manifestVersion は 4 以上が必要です' }
if ([int]($hosts[0].minVersion -split '\.')[0] -lt 22) { throw 'host.minVersion は 22 以上が必要です' }
if (-not ($manifest.icons -is [array])) { throw 'manifest に icons 配列が必要です' }
foreach ($ep in @($manifest.entrypoints)) {
    if ($ep.type -eq 'panel' -and -not ($ep.icons -is [array])) {
        throw "panel entrypoint '$($ep.id)' に icons 配列が必要です"
    }
}

# パッケージに含めるもの（これ以外は入れない）
$include = @(
    'manifest.json',
    'index.html',
    'styles.css',
    'main.js',
    'extendscript.js',
    'README.md',
    'icons/icon.png',
    'icons/icon@2x.png',
    'scripts/lassoDraw Toggle.jsx'
)

foreach ($rel in $include) {
    if (-not (Test-Path (Join-Path $root $rel))) { throw "見つかりません: $rel" }
}

$distDir = Join-Path $root 'dist'
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
$out = Join-Path $distDir $pkgName
if (Test-Path $out) { Remove-Item $out -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# CreateFromDirectory は .NET Framework だとエントリ名が "\" になり ZIP 仕様に反する。
# エントリ名を "/" にするため 1 件ずつ追加する。
$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($rel in $include) {
        $entryName = $rel -replace '\\', '/'
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, (Join-Path $root $rel), $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
}
finally {
    $zip.Dispose()
}

Write-Host ("作成しました: {0} ({1:N0} バイト)" -f $out, (Get-Item $out).Length)
foreach ($rel in $include) { Write-Host ("  + " + ($rel -replace '\\', '/')) }
