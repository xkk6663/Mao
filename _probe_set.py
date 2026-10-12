import io, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# 1. 设置页导航 items（index.js）
p = r'C:\Users\xiao1\Mio\澪Agent应用\dist\assets\index-BBVquePX.js'
c = io.open(p, encoding='utf-8', errors='replace').read()
out = []
# 找设置分类 label 出现处
for kw in ['小智', '通用', '对话', '外观', '提示词', '图片识别']:
    out.append('%s: %d' % (kw, c.count(kw)))
# 找 settings 导航 items 定义（Gr 函数附近）
i = c.find('settings-window-navigation')
out.append('nav_idx=%d' % i)
# 找 items 定义：搜索 "label:" 模式附近（Vue 设置分类）
j = c.find('设置分类')
out.append('settings_class_idx=%d' % j)
open(r'C:\Users\xiao1\Mio\_o20.txt', 'w', encoding='utf-8').write('\n'.join(out))
print('done')
