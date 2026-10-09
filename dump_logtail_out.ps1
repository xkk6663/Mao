$log = "C:\Users\xiao1\Mio\backend_out.log"
$out = "C:\Users\xiao1\Mio\logtail_out.txt"
if (Test-Path $log) {
  $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
  try {
    $len = $fs.Length
    $start = [Math]::Max(0, $len - 6000)
    $fs.Position = $start
    $buf = New-Object byte[] ($len - $start)
    $fs.Read($buf, 0, $buf.Length) | Out-Null
    $text = [System.Text.Encoding]::UTF8.GetString($buf)
    [System.IO.File]::WriteAllText($out, $text, (New-Object System.Text.UTF8Encoding $false))
  } finally { $fs.Dispose() }
  "written"
} else { "不存在" }
