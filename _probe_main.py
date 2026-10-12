import io, re, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
p = r'C:\Users\xiao1\Mio\澪Agent应用\live2d-desktop\main.js'
c = io.open(p, encoding='utf-8', errors='replace').read()
print('len=', len(c))
# toggleChatWindow / openXiaozhi / chatWindow 创建逻辑
for kw in ['toggleChatWindow', 'openXiaozhi', 'function openChat', 'chatWindow =', 'createChatWindow', 'loadURL']:
    pos = 0
    while True:
        i = c.find(kw, pos)
        if i < 0: break
        print(f'--- {kw} @{i} ---')
        print(c[max(0,i-150):i+400])
        pos = i + 1
        if pos > i: pos = i + len(kw)
