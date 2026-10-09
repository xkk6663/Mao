$c = [IO.File]::ReadAllText("C:\Users\xiao1\Mio\澪Agent应用\dist\assets\ChatPage-lp32YBdY.js", (New-Object Text.UTF8Encoding($false)))
"followChat出现次数: " + ([regex]::Matches($c, "followChat")).Count
"scrollTop出现次数: " + ([regex]::Matches($c, "scrollTop")).Count
"sentence_start出现次数: " + ([regex]::Matches($c, "sentence_start")).Count
# 取 sentence_start 分支上下文，确认 push 后有滚动
$i = $c.IndexOf("sentence_start")
$seg = $c.Substring($i, [Math]::Min(400, $c.Length - $i))
"--- sentence_start 分支片段 ---"
$seg
