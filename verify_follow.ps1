$html = Invoke-WebRequest "http://127.0.0.1:8000/agent-app/" -TimeoutSec 10 -UseBasicParsing
$hasNew = $html.Content -match "ChatPage-CyjlIy0G"
"index.html 引用新ChatPage: $hasNew"
$chunk = "C:\Users\xiao1\Mio\澪Agent应用\dist\assets\ChatPage-CyjlIy0G.js"
$c = [IO.File]::ReadAllText($chunk, (New-Object Text.UTF8Encoding($false)))
"followChat逻辑: $($c -match 'mio_chat_follow')"
"跟随按钮: $($c -match 'follow-chat-toggle')"
