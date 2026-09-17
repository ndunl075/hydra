param([Parameter(Mandatory)][string]$LogoPath, [Parameter(Mandatory)][string]$ResourceDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$hydraOriginal = [Drawing.Image]::FromFile((Resolve-Path -LiteralPath $LogoPath).Path)
$hydraResources = (Resolve-Path -LiteralPath $ResourceDirectory).Path
try {
  $hydraFrames = @()
  foreach ($hydraSize in @(16, 32, 48, 64, 128, 256, 70, 150)) {
    $hydraBitmap = [Drawing.Bitmap]::new($hydraSize, $hydraSize, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $hydraGraphics = [Drawing.Graphics]::FromImage($hydraBitmap)
    $hydraMemory = [IO.MemoryStream]::new()
    try {
      $hydraGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $hydraGraphics.DrawImage($hydraOriginal, 0, 0, $hydraSize, $hydraSize)
      $hydraBitmap.Save($hydraMemory, [Drawing.Imaging.ImageFormat]::Png)
      if ($hydraSize -in @(70, 150)) { [IO.File]::WriteAllBytes((Join-Path $hydraResources "code_${hydraSize}x${hydraSize}.png"), $hydraMemory.ToArray()) }
      else { $hydraFrames += [PSCustomObject]@{ Size = $hydraSize; Bytes = $hydraMemory.ToArray() } }
    } finally { $hydraMemory.Dispose(); $hydraGraphics.Dispose(); $hydraBitmap.Dispose() }
  }
  $hydraIconStream = [IO.File]::Create((Join-Path $hydraResources 'code.ico'))
  $hydraWriter = [IO.BinaryWriter]::new($hydraIconStream)
  try {
    $hydraWriter.Write([UInt16]0); $hydraWriter.Write([UInt16]1); $hydraWriter.Write([UInt16]$hydraFrames.Count)
    $hydraOffset = 6 + 16 * $hydraFrames.Count
    foreach ($hydraFrame in $hydraFrames) {
      $hydraDimension = if ($hydraFrame.Size -eq 256) { 0 } else { $hydraFrame.Size }
      $hydraWriter.Write([byte]$hydraDimension); $hydraWriter.Write([byte]$hydraDimension); $hydraWriter.Write([byte]0); $hydraWriter.Write([byte]0)
      $hydraWriter.Write([UInt16]1); $hydraWriter.Write([UInt16]32); $hydraWriter.Write([UInt32]$hydraFrame.Bytes.Length); $hydraWriter.Write([UInt32]$hydraOffset)
      $hydraOffset += $hydraFrame.Bytes.Length
    }
    foreach ($hydraFrame in $hydraFrames) { $hydraWriter.Write([byte[]]$hydraFrame.Bytes) }
  } finally { $hydraWriter.Dispose() }
} finally { $hydraOriginal.Dispose() }
Write-Output 'Converted the unchanged README logo into Windows icon sizes.'
