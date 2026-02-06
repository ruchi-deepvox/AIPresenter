param(
    [Parameter(Mandatory=$true)][string]$InputFile,
    [Parameter(Mandatory=$true)][string]$OutputDir,
    [int]$Width = 1920,
    [int]$Height = 1080
)

$ErrorActionPreference = 'Stop'

# Resolve to absolute paths
$InputFile = (Resolve-Path $InputFile).Path

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
$OutputDir = (Resolve-Path $OutputDir).Path

$pptApp = $null
$presentation = $null

try {
    $pptApp = New-Object -ComObject PowerPoint.Application

    # Open presentation: ReadOnly=True, Untitled=False, WithWindow=False
    $presentation = $pptApp.Presentations.Open($InputFile, $true, $false, $false)

    $slideCount = $presentation.Slides.Count

    for ($i = 1; $i -le $slideCount; $i++) {
        $slide = $presentation.Slides.Item($i)
        $outputPath = Join-Path $OutputDir "slide_$i.png"
        $slide.Export($outputPath, "PNG", $Width, $Height)
    }

    $presentation.Close()
    $presentation = $null

    Write-Output "SUCCESS:$slideCount"
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    if ($presentation) {
        try { $presentation.Close() } catch {}
    }
    if ($pptApp) {
        try { $pptApp.Quit() } catch {}
        try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($pptApp) | Out-Null } catch {}
    }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
