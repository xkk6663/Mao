$idx = [IO.File]::ReadAllText("C:\Users\xiao1\Mio\澪Agent应用\dist\index.html", (New-Object Text.UTF8Encoding($false)))
$m = [regex]::Match($idx, "assets/(index-[^""]+\.js)")
$entryName = $m.Groups[1].Value
"入口chunk: $entryName"
$entry = "C:\Users\xiao1\Mio\澪Agent应用\dist\assets\" + $entryName
$e = [IO.File]::ReadAllText($entry, (New-Object Text.UTF8Encoding($false)))
"入口引用新ChatPage: " + ($e -match "ChatPage-CyjlIy0G")
