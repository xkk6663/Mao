# 升级版本号（显式 UTF-8 读写，避免 GBK 写坏）
$files = @(
  "C:\Users\xiao1\Mio\澪Agent应用\live2d-desktop\main.js",
  "C:\Users\xiao1\Mio\_mio_orig\Mio-main\澪Agent应用\live2d-desktop\main.js"
)
foreach ($f in $files) {
  $t = [IO.File]::ReadAllText($f, (New-Object Text.UTF8Encoding($false)))
  $t = $t.Replace("v=20261009-src-v11", "v=20261009-src-v12")
  $t = $t.Replace('frontend: "runtime-v10"', 'frontend: "runtime-v12"')
  $t = $t.Replace("frontend: 'runtime-v10'", "frontend: 'runtime-v12'")
  [IO.File]::WriteAllText($f, $t, (New-Object Text.UTF8Encoding($false)))
  "updated: $f"
}
# node --check 校验
node --check "C:\Users\xiao1\Mio\澪Agent应用\live2d-desktop\main.js"
"node --check OK"
# 中文无乱码检查
$c = [IO.File]::ReadAllText("C:\Users\xiao1\Mio\澪Agent应用\live2d-desktop\main.js", (New-Object Text.UTF8Encoding($false)))
if ($c -match 'src-v12') { "src-v12 OK" } else { "src-v12 MISSING" }
