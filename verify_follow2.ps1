$idx = [IO.File]::ReadAllText("C:\Users\xiao1\Mio\澪Agent应用\dist\index.html", (New-Object Text.UTF8Encoding($false)))
$m = [regex]::Match($idx, "assets/(index-[^""]+\.js)")
$entry = "C:\Users\xiao1\Mio\澪Agent应用\dist\assets\" + $m.Groups[1].Value
$e = [IO.File]::ReadAllText($entry, (New-Object Text.UTF8Encoding($false)))
$chunk = "C:\Users\xiao1\Mio\澪Agent应用\dist\assets\ChatPage-lp32YBdY.js"
$c = [IO.File]::ReadAllText($chunk, (New-Object Text.UTF8Encoding($false)))
"入口引用新ChatPage: " + ($e -match "ChatPage-lp32YBdY")
"sentence_start显式滚动: " + ($c -match "sentence_start.*xzScrollToBottom|xzScrollToBottom\(\).*sentence_start")
"flush post: " + ($c -match "flush")
"follow按钮: " + ($c -match "follow-chat-toggle")
