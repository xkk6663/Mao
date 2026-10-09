# 读后端日志尾部
$log = "C:\Users\xiao1\Mio\backend_err.log"
if (Test-Path $log) {
  $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
  try {
    $len = $fs.Length
    $start = [Math]::Max(0, $len - 3000)
    $fs.Position = $start
    $buf = New-Object byte[] ($len - $start)
    $fs.Read($buf, 0, $buf.Length) | Out-Null
    [System.Text.Encoding]::UTF8.GetString($buf)
  } finally { $fs.Dispose() }
} else { "日志不存在" }
