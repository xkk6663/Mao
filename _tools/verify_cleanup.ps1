$lines = @()
try {
  $x = Invoke-RestMethod "http://127.0.0.1:8000/api/xiaozhi/status" -TimeoutSec 8
  $lines += "xiaozhi: connected=" + $x.connected + " subscribers=" + $x.subscribers
} catch { $lines += "xiaozhi status FAIL: " + $_.Exception.Message }
$fs = [System.IO.File]::Open("C:\Users\xiao1\Mio\backend_err.log", 'Open', 'Read', 'ReadWrite')
try {
  $len = $fs.Length
  $start = [Math]::Max(0, $len - 2000)
  $fs.Position = $start
  $buf = New-Object byte[] ($len - $start)
  $fs.Read($buf, 0, $buf.Length) | Out-Null
  $lines += "--- backend_err tail ---"
  $lines += ([System.Text.Encoding]::UTF8.GetString($buf) -split "`n") | Select-Object -Last 15
} finally { $fs.Dispose() }
[System.IO.File]::WriteAllLines("C:\Users\xiao1\Mio\verify_cleanup.txt", $lines, (New-Object System.Text.UTF8Encoding $false))
