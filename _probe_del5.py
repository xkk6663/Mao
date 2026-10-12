import io, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
p = r'C:\Users\xiao1\Mio\澪Agent应用\dist\assets\index-BBVquePX.js'
c = io.open(p, encoding='utf-8', errors='replace').read()

out = []
out.append('len=%d' % len(c))
out.append('gate_open=%d' % c.count('xiaozhi-gate-open'))
out.append('gate_body=%d' % c.count('xiaozhi-gate-body'))
out.append('gate_class=%d' % c.count('xiaozhi-chat-gate'))
out.append('openXiaozhiChat=%d' % c.count('openXiaozhiChat'))
out.append('openXiaozhi=%d' % c.count('openXiaozhi'))
out.append('isAgentWorkspace=%d' % c.count('isAgentWorkspace'))

# chat 渲染分支：找 ii 组件渲染处
i = c.find('I(e(ii),{key:4})')
out.append('chatpage_render_idx=%d' % i)
if i >= 0:
    out.append('--- chat 分支上下文 ---')
    out.append(c[max(0,i-1500):i+500])

# openXiaozhiChat 定义
j = c.find('openXiaozhiChat')
out.append('')
out.append('openXiaozhiChat_first=%d' % j)
if j >= 0:
    out.append('--- openXiaozhiChat 上下文 ---')
    out.append(c[max(0,j-700):j+400])

# Ja agent chat 分支
k = c.find('isAgentWorkspace&&(t=ua(t))')
out.append('')
out.append('Ja_agent_idx=%d' % k)
if k >= 0:
    out.append('--- Ja 上下文 ---')
    out.append(c[max(0,k-200):k+900])

open(r'C:\Users\xiao1\Mio\_o18.txt', 'w', encoding='utf-8').write('\n'.join(out))
print('done')
