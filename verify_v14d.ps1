$c = [IO.File]::ReadAllText("C:\Users\xiao1\Mio\澪Agent应用\dist\assets\CompanionPage-D7yDEAVz.js", (New-Object Text.UTF8Encoding($false)))
"观察标签: " + ($c -match "observe_enabled")
"观察中文: " + ($c -match "观察中")
"vision-info: " + ($c -match "vision-info")
