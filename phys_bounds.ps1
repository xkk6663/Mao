$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$left = 0; $top = 0; $right = 0; $bottom = 0; $primaryW = 0
foreach ($s in $screens) {
    $bd = $s.Bounds
    $ex = $bd.X + $bd.Width
    $ey = $bd.Y + $bd.Height
    if ($bd.Width -gt $primaryW) { $primaryW = $bd.Width }
    if ($bd.X -lt $left) { $left = $bd.X }
    if ($bd.Y -lt $top) { $top = $bd.Y }
    if ($ex -gt $right) { $right = $ex }
    if ($ey -gt $bottom) { $bottom = $ey }
}
Write-Output "$left,$top,$right,$bottom,$primaryW"
