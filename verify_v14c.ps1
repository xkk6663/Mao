$cp = Get-ChildItem "C:\Users\xiao1\Mio\澪Agent应用\dist\assets\CompanionPage-*.js" | Select-Object -First 1
$c = [IO.File]::ReadAllText($cp.FullName, (New-Object Text.UTF8Encoding($false)))
"CompanionPage chunk: $($cp.Name)"
"含companion-sidebar: " + ($c -match "companion-sidebar")
"含小智状态文案: " + ($c -match "小智状态")
"含Wifi图标: " + ($c -match "Wifi")
"含xz-status-list: " + ($c -match "xz-status-list")
"含loadXzStatus(观察标签用): " + ($c -match "loadXzStatus")
