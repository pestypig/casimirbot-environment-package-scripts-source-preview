# Read-only local prerequisite report. Does not sign, authenticate or deploy.
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Push-Location -LiteralPath $repoRoot
try {
    $head = (& git --no-optional-locks rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read HEAD' }
    $branch = (& git --no-optional-locks branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read branch' }
    $status = @(& git --no-optional-locks status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read working-tree status' }
    $staged = @(& git --no-optional-locks diff --cached --name-only)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read index status' }
    $version = (Get-Content -LiteralPath 'apps/desktop/package.json' -Raw | ConvertFrom-Json).version
    $expectedTag = "desktop-v$version"
    & git --no-optional-locks show-ref --verify --quiet "refs/tags/$expectedTag"
    $tagExists = $LASTEXITCODE -eq 0
    $tagMatchesHead = $false
    if ($tagExists) {
        $tagCommit = (& git --no-optional-locks rev-list -n 1 $expectedTag).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve release tag' }
        $tagMatchesHead = $tagCommit -eq $head
    }
    $slice = (& node apps/desktop/scripts/audit-release-slice.mjs --json | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw 'Release-slice audit failed to execute' }
    $memory = Get-CimInstance Win32_OperatingSystem
    $freeRamGiB = [math]::Round($memory.FreePhysicalMemory / 1MB, 3)
    $freeDiskGiB = [math]::Round((Get-PSDrive -Name C).Free / 1GB, 3)
    $backend = [string]$env:CASIMIR_DESKTOP_SIGNING_BACKEND
    $signingVariables = if ($backend -eq 'azure') {
        @('WINDOWS_PUBLISHER_NAME','AZURE_ARTIFACT_SIGNING_ENDPOINT','AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME','AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME','AZURE_TENANT_ID','AZURE_CLIENT_ID','AZURE_SUBSCRIPTION_ID')
    } elseif ($backend -eq 'pfx') {
        @('WINDOWS_PUBLISHER_NAME','CSC_LINK','CSC_KEY_PASSWORD')
    } else { @('CASIMIR_DESKTOP_SIGNING_BACKEND') }
    $missingSigningVariableNames = @($signingVariables | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) })
    [pscustomobject]@{
        schema = 'casimirbot.local_release_readiness_report.v1'
        mode = 'read_only_no_auth_no_sign_no_deploy'
        branch = $branch
        head = $head
        expectedTag = $expectedTag
        tagExists = $tagExists
        tagMatchesHead = $tagMatchesHead
        workingTreeClean = $status.Count -eq 0
        changedPathCount = $status.Count
        stagedPathCount = $staged.Count
        releaseSliceVerdict = $slice.verdict
        releaseSliceOwnedChanged = $slice.counts.ownedChanged
        releaseSliceSharedReview = $slice.counts.sharedChanged
        freeRamGiB = $freeRamGiB
        fourGiBRamPreconditionMet = $freeRamGiB -ge 4
        freeDiskGiB = $freeDiskGiB
        signingBackendConfigured = $backend -in @('azure','pfx')
        missingSigningVariableNames = $missingSigningVariableNames
        adapterVerifyUrlConfigured = -not [string]::IsNullOrWhiteSpace($env:CASIMIR_ADAPTER_VERIFY_URL)
        signingAccessVerified = $false
        runtimeAndDomainParityVerified = $false
    } | ConvertTo-Json -Depth 5
} finally {
    Pop-Location
}
