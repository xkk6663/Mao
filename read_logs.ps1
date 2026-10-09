$out = "C:\Users\xiao1\Mio\backend_out.log"
$err = "C:\Users\xiao1\Mio\backend_err.log"
foreach ($f in @($out, $err)) {
  $bytes = [IO.File]::ReadAllBytes($f)
  "===== $f  size=$($bytes.Length) ====="
  $txt = [IO.File]::ReadAllText($f, (New-Object Text.UTF8Encoding($false, $true)))
  $lines = $txt -split "`n"
  "total lines: $($lines.Count)"
  $tail = $lines | Select-Object -Last 25
  $tail -join "`n"
  ""
}
