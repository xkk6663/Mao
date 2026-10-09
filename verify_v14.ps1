$idx = [IO.File]::ReadAllText("C:\Users\xiao1\Mio\澪Agent应用\dist\index.html", (New-Object Text.UTF8Encoding($false)))
$m = [regex]::Match($idx, "assets/(index-[^""]+\.js)")
$entry = "C:\Users\xiao1\Mio\澪Agent应用\dist\assets\" + $m.Groups[1].Value
$e = [IO.File]::ReadAllText($entry, (New-Object Text.UTF8Encoding($false)))
"入口chunk: $($m.Groups[1].Value)"
"入口含旧右侧栏模板(integrated-right-rail): " + ($e -match "integrated-right-rail")
$chat = Get-ChildItem "C:\Users\xiao1\Mio\澪Agent应用\dist\assets\ChatPage-*.js" | Select-Object -First 1
$c = [IO.File]::ReadAllText($chat.FullName, (New-Object Text.UTF8Encoding($false)))
"ChatPage chunk: $($chat.Name)"
"含xz-status-fullscreen: " + ($c -match "xz-status-fullscreen")
"含Wifi按钮: " + ($c -match "xzStatusPanelOpen")
"含sentence_start滚动: " + ($c -match "sentence_start")
"不含xz-link-status: " + (-not ($c -match "xz-link-status"))
