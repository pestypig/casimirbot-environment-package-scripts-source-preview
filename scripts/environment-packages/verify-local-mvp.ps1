param(
    [string]$Checkpoint = '.tmp/local-mvp-source-checkpoint-post-native-build-inputs',
    [switch]$RunTests,
    [switch]$FullInventory
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$checkpointRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $Checkpoint))
$temporaryRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot '.tmp'))
if (-not $checkpointRoot.StartsWith($temporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Checkpoint must be inside the repository .tmp directory.'
}
$manifestPath = Join-Path $checkpointRoot 'manifest.json'
$patchPath = Join-Path $checkpointRoot 'source.patch'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
    throw 'Checkpoint manifest or patch is missing.'
}
Push-Location -LiteralPath $repoRoot
try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 'casimirbot.local_mvp_source_checkpoint.v1') { throw 'Unexpected checkpoint schema.' }
    $head = (& git --no-optional-locks rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -ne $manifest.baseline) { throw 'Checkpoint baseline no longer matches HEAD.' }
    $patchHash = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($patchHash -ne $manifest.patchSha256) { throw 'Checkpoint patch hash mismatch.' }
    foreach ($item in $manifest.files) {
        $file = Join-Path $repoRoot $item.file
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Checkpoint input missing: $($item.file)" }
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne $item.sha256) { throw "Checkpoint input changed: $($item.file)" }
    }
    & git --no-optional-locks apply --reverse --check -- $patchPath
    if ($LASTEXITCODE -ne 0) { throw 'Checkpoint patch does not reverse-apply to this working tree.' }

    & node (Join-Path $PSScriptRoot 'review-local-mvp-dependencies.cjs') $manifestPath
    if ($LASTEXITCODE -ne 0) { throw 'Dependency review failed.' }

    & (Join-Path $PSScriptRoot 'launch-local-mvp.ps1') -CheckOnly
    if ($LASTEXITCODE -ne 0) { throw 'Retained private executable preflight failed.' }

    if ($FullInventory) {
        $candidateRoot = Join-Path $repoRoot '.tmp/g16a-full-app-YWB9I4'
        $installRoot = [IO.Path]::GetFullPath((Join-Path $candidateRoot 'local-executable'))
        $buildManifest = Get-Content -LiteralPath (Join-Path $candidateRoot 'local-executable-manifest.json') -Raw | ConvertFrom-Json
        if ($buildManifest.schema -ne 'casimirbot.private_local_executable.v1' -or $buildManifest.signed -ne $false -or $buildManifest.published -ne $false) {
            throw 'Unexpected retained private executable manifest.'
        }
        $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($item in $buildManifest.files) {
            $relative = [string]$item.path
            if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[/\\])\.\.([/\\]|$)') { throw "Unsafe inventory path: $relative" }
            $file = [IO.Path]::GetFullPath((Join-Path $installRoot $relative))
            if (-not $file.StartsWith($installRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Inventory path escapes install: $relative" }
            if (-not $paths.Add($file)) { throw "Duplicate inventory path: $relative" }
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Installed file missing: $relative" }
            $bytes = (Get-Item -LiteralPath $file).Length
            if ($bytes -ne $item.bytes) { throw "Installed file length mismatch: $relative" }
            $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($hash -ne $item.sha256) { throw "Installed file hash mismatch: $relative" }
        }
        Write-Output "Full retained executable inventory PASS: $($paths.Count) files."
    }

    if ($RunTests) {
        & node (Join-Path $repoRoot 'node_modules/vitest/vitest.mjs') run tests/local-mvp-update-guards.spec.ts client/src/components/workstation/__tests__/WorkstationPathBar.suggestions.spec.tsx server/mcp/__tests__/helix-mcp-public-ui-catalog.test.ts --pool=forks
        if ($LASTEXITCODE -ne 0) { throw 'Targeted local MVP tests failed.' }
    }
    Write-Output "Local MVP preflight PASS: $($manifest.files.Count) hash-current files; private executable checked; tests $(if ($RunTests) {'passed'} else {'not requested'})."
} finally {
    Pop-Location
}
