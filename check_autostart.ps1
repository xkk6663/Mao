$lines = @()
$lines += "=== 1. Electron/桌宠进程 ==="
Get-CimInstance Win32_Process | Where-Object { $_.Name -match "electron|澪Agent" -or $_.CommandLine -match "live2d" } | ForEach-Object {
  $lines += ("PID={0} NAME={1} CMD={2}" -f $_.ProcessId, $_.Name, $_.CommandLine.Substring(0, [Math]::Min(120, $_.CommandLine.Length)))
}
$lines += ""
$lines += "=== 2. 后端进程 ==="
Get-CimInstance Win32_Process | Where-Object { $_.Name -match "python" -and $_.CommandLine -match "uvicorn" } | ForEach-Object {
  $lines += ("PID={0} CMD={1}" -f $_.ProcessId, $_.CommandLine.Substring(0, [Math]::Min(100, $_.CommandLine.Length)))
}
$lines += ""
$lines += "=== 3. 启动文件夹 Startup ==="
$startup = [Environment]::GetFolderPath('Startup')
$lines += "Path: $startup"
Get-ChildItem $startup -Force -ErrorAction SilentlyContinue | ForEach-Object { $lines += ("{0}  target={1}" -f $_.Name, $_.LinkType) }
Get-ChildItem $startup -Force -ErrorAction SilentlyContinue | Where-Object { $_.Extension -eq ".lnk" } | ForEach-Object {
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($_.FullName)
  $lines += ("LNK: {0} -> {1} args={2}" -f $_.Name, $lnk.TargetPath, $lnk.Arguments)
}
$lines += ""
$lines += "=== 4. 计划任务(mio/pet/live2d) ==="
$lines += (schtasks /query /fo LIST 2>$null | Select-String -Pattern "mio|Mio|pet|Pet|live2d|Live2D|桌宠" | ForEach-Object { $_.Line } | Select-Object -First 20)
$lines += ""
$lines += "=== 5. 桌面脚本 ==="
$desktop = [Environment]::GetFolderPath('Desktop')
Get-ChildItem $desktop -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "桌宠|Mio|mio|一键" } | ForEach-Object { $lines += ("{0}  {1}KB" -f $_.Name, [math]::Round($_.Length/1KB,1)) }
$lines += ""
$lines += "=== 6. setup_autostart.ps1 全文 ==="
$lines += (Get-Content "C:\Users\xiao1\Mio\setup_autostart.ps1" -Encoding UTF8)
[System.IO.File]::WriteAllLines("C:\Users\xiao1\Mio\autostart_check.txt", $lines, (New-Object System.Text.UTF8Encoding $false))
"written"
