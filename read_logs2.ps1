$err = "C:\Users\xiao1\Mio\backend_err.log"
$txt = [IO.File]::ReadAllText($err, (New-Object Text.UTF8Encoding($false, $true)))
$lines = $txt -split "`n"
$tail = $lines | Select-Object -Last 30
$tail -join "`n"
