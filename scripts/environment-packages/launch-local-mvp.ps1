param([switch]$CheckOnly, [string]$CandidateRoot)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (-not $CandidateRoot) { $CandidateRoot = Join-Path $repoRoot '.tmp/g16a-full-app-YWB9I4' }
$candidateRoot = (Resolve-Path -LiteralPath $CandidateRoot).Path
$privateBuildRoot = (Resolve-Path -LiteralPath (Join-Path $repoRoot '.tmp')).Path
if ((Split-Path -Parent $candidateRoot) -ne $privateBuildRoot) { throw 'Expected a private candidate inside this repository .tmp directory.' }
$manifest = Get-Content -LiteralPath (Join-Path $candidateRoot 'local-executable-manifest.json') -Raw | ConvertFrom-Json
$candidate = Get-Content -LiteralPath (Join-Path $candidateRoot 'candidate.json') -Raw | ConvertFrom-Json
$executable = (Resolve-Path -LiteralPath (Join-Path $candidateRoot 'local-executable/CasimirBot-Local-MVP.exe')).Path
$profileRoot = Join-Path $env:LOCALAPPDATA 'CasimirBot-private-validation'
$profilePin = Join-Path $profileRoot 'local-mvp-profile.json'
# One retained profile across candidate updates. Only first adoption uses the
# already established MVP profile; never derive a new profile from the build ID.
$profileDirectory = 'local-mvp-YWB9I4'
if (Test-Path -LiteralPath $profilePin) {
    $pin = Get-Content -LiteralPath $profilePin -Raw | ConvertFrom-Json
    if ($pin.schema -ne 'casimirbot.private_profile_pin.v1' -or $pin.profileDirectory -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$') { throw 'Invalid retained profile record; refusing to replace it.' }
    $profileDirectory = $pin.profileDirectory
}
$profile = Join-Path $profileRoot $profileDirectory
if ($manifest.schema -ne 'casimirbot.private_local_executable.v1' -or $manifest.signed -ne $false -or $manifest.published -ne $false -or $candidate.privateLocalMvp -ne $true -or $manifest.executable -ne $executable) { throw 'Expected the retained private local MVP candidate.' }
if (-not (Test-Path -LiteralPath $profile -PathType Container)) { throw 'Existing local MVP profile is missing; refusing to create a replacement.' }
foreach ($profilePath in @($profileRoot, $profile)) {
    if ((Get-Item -LiteralPath $profilePath).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Profile selection cannot follow a reparse point.' }
}
$criticalFiles = @(
    'CasimirBot-Local-MVP.exe',
    'resources/app/dist/main.cjs',
    'resources/app/dist/service.mjs',
    'resources/app/dist/service-dependencies.json',
    'resources/runtime/runtime-manifest.json',
    'resources/runtime/dist/public/local-reference-canvas.html',
    'resources/runtime/dist/public/local-reference-canvas.js'
)
foreach ($relativeFile in $criticalFiles) {
    $entry = @($manifest.files | Where-Object { $_.path -eq $relativeFile })
    $absoluteFile = Join-Path (Join-Path $candidateRoot 'local-executable') $relativeFile
    if ($entry.Count -ne 1 -or (Get-FileHash -LiteralPath $absoluteFile -Algorithm SHA256).Hash -ne $entry[0].sha256) { throw "Critical local build inventory mismatch: $relativeFile" }
}
$running = @(Get-Process -Name 'CasimirBot-Local-MVP' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable })
if ($CheckOnly) { Write-Output "Private candidate and existing profile verified. Running processes: $($running.Count). Home preview enabled on launch."; return }
# This record contains only the selected folder name, never keys or sessions.
# CreateNew preserves a concurrently established choice rather than overwriting it.
if (-not (Test-Path -LiteralPath $profilePin)) {
    $pinJson = @{ schema = 'casimirbot.private_profile_pin.v1'; profileDirectory = $profileDirectory } | ConvertTo-Json
    $pinStream = [System.IO.File]::Open($profilePin, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    try { $pinBytes = [System.Text.Encoding]::UTF8.GetBytes($pinJson); $pinStream.Write($pinBytes, 0, $pinBytes.Length) } finally { $pinStream.Dispose() }
}
if ($running.Count -gt 0) { Write-Output 'The local MVP is already running; use its existing window.'; return }
if ((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 4MB) { throw 'At least 4 GiB of free memory is required before launching the private desktop.' }
$previousHomeFlag = $env:HELIX_PRIVATE_ENVIRONMENT_HOME
try {
    $env:HELIX_PRIVATE_ENVIRONMENT_HOME = '1'
    Start-Process -FilePath $executable -ArgumentList ('--user-data-dir="' + $profile + '"') -WorkingDirectory $repoRoot | Out-Null
} finally {
    $env:HELIX_PRIVATE_ENVIRONMENT_HOME = $previousHomeFlag
}
