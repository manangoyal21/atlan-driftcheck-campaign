param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$exportRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $exportRoot "export-manifest.json"

$expectedFiles = @(
    "README.md",
    "LICENSE",
    "export-manifest.json",
    "verify-public-skill.ps1",
    "skills/skill-drift-check/SKILL.md",
    "skills/skill-drift-check/schemas/skills-lock-v1.schema.json",
    "skills/skill-drift-check/runtime/cache.js",
    "skills/skill-drift-check/runtime/cli.js",
    "skills/skill-drift-check/runtime/commands.js",
    "skills/skill-drift-check/runtime/discovery.js",
    "skills/skill-drift-check/runtime/git.js",
    "skills/skill-drift-check/runtime/hash.js",
    "skills/skill-drift-check/runtime/lockfile.js",
    "skills/skill-drift-check/runtime/package.json",
    "skills/skill-drift-check/runtime/sync.js",
    "skills/skill-drift-check/runtime/types.js"
) | Sort-Object

$actualFiles = Get-ChildItem -Path $exportRoot -Recurse -File -Force |
    ForEach-Object {
        $_.FullName.Substring($exportRoot.Length + 1).Replace("\", "/")
    } |
    Sort-Object

if (Compare-Object $expectedFiles $actualFiles) {
    throw "Public export contains missing or unexpected files.`n$(
        Compare-Object $expectedFiles $actualFiles | Out-String
    )"
}

$forbiddenPathSegments = @(
    "challenge",
    "research",
    "outreach",
    "campaign",
    "personal",
    "profile",
    "journal",
    "todo",
    "presentation"
)
foreach ($relativePath in $actualFiles) {
    $segments = $relativePath.ToLowerInvariant().Split("/")
    foreach ($forbidden in $forbiddenPathSegments) {
        if ($segments -contains $forbidden) {
            throw "Forbidden public path segment '$forbidden' in $relativePath."
        }
    }
}

$forbiddenBrand = [string]::Concat("at", "lan")
foreach ($relativePath in $actualFiles) {
    $candidate = Join-Path $exportRoot ($relativePath.Replace("/", "\"))
    if ((Get-Content $candidate -Raw) -match "(?i)$forbiddenBrand") {
        throw "Removed brand remains in public file $relativePath."
    }
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($manifest.format -ne "skill-drift-check-public-export" -or $manifest.version -ne 1) {
    throw "Unsupported export manifest."
}
if ($manifest.license -ne "MIT" -or $manifest.licenseStatus -ne "approved") {
    throw "Public export must use the approved MIT license."
}
$manifestPaths = @($manifest.files | ForEach-Object { $_.path }) | Sort-Object
$hashablePaths = @($actualFiles | Where-Object { $_ -ne "export-manifest.json" })
if (Compare-Object $manifestPaths $hashablePaths) {
    throw "Export manifest file list does not match the public tree."
}
foreach ($entry in $manifest.files) {
    $candidate = Join-Path $exportRoot ($entry.path.Replace("/", "\"))
    $actualHash = (Get-FileHash -Algorithm SHA256 -Path $candidate).Hash.ToLowerInvariant()
    if ($actualHash -ne $entry.sha256) {
        throw "Export hash mismatch for $($entry.path)."
    }
}

$skillText = Get-Content (Join-Path $exportRoot "skills\skill-drift-check\SKILL.md") -Raw
if ($skillText -notmatch "(?m)^name: skill-drift-check\r?$" -or
    $skillText -notmatch "(?m)^description: ") {
    throw "SKILL.md is missing required Agent Skills frontmatter."
}
if ($skillText -match "(?m)^driftcheck (audit|verify|sync)") {
    throw "SKILL.md must use the bundled runtime without npm installation."
}

$runtimePackage = Get-Content (
    Join-Path $exportRoot "skills\skill-drift-check\runtime\package.json"
) -Raw | ConvertFrom-Json
if ($runtimePackage.type -ne "module" -or
    $null -ne $runtimePackage.dependencies -or
    $null -ne $runtimePackage.optionalDependencies -or
    $null -ne $runtimePackage.peerDependencies) {
    throw "Bundled runtime package must be ESM and dependency-free."
}

& node (Join-Path $exportRoot "skills\skill-drift-check\runtime\cli.js") --help | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Bundled CLI help failed with exit code $LASTEXITCODE."
}

if (-not $SkipInstall) {
    $testRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
        "skill-drift-check-public-install-" + [guid]::NewGuid().ToString("N")
    )
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    Push-Location $testRoot
    try {
        $env:DISABLE_TELEMETRY = "1"
        $env:DO_NOT_TRACK = "1"
        Write-Host "Installing local export with skills CLI..."
        & npx --yes skills add $exportRoot --skill skill-drift-check --agent codex --copy --yes
        if ($LASTEXITCODE -ne 0) {
            throw "skills add failed with exit code $LASTEXITCODE."
        }

        $installedSkills = @(
            Get-ChildItem -Path $testRoot -Filter "SKILL.md" -Recurse -File -Force
        )
        if ($installedSkills.Count -ne 1) {
            throw "Expected exactly one installed skill; found $($installedSkills.Count)."
        }
        $installedSkill = $installedSkills[0].Directory.FullName
        if ($installedSkills[0].Directory.Name -ne "skill-drift-check") {
            throw "Installed skill was not named skill-drift-check."
        }
        $installedCli = Join-Path $installedSkill "runtime\cli.js"
        if (-not (Test-Path $installedCli)) {
            throw "Installed skill is missing its bundled CLI."
        }
        if (Get-ChildItem -Path $testRoot -Directory -Filter "node_modules" -Recurse -Force) {
            throw "Skill installation unexpectedly created runtime node_modules."
        }

        & node $installedCli --help | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Installed bundled CLI help failed."
        }
        & node $installedCli audit --root $testRoot | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "Installed bundled CLI audit failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
        Remove-Item Env:DISABLE_TELEMETRY -ErrorAction SilentlyContinue
        Remove-Item Env:DO_NOT_TRACK -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $testRoot -ErrorAction SilentlyContinue
    }
}

Write-Host "Public skill export verification passed."
