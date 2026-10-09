# 升级版本号 v12 -> v13（显式 UTF-8）
$files = @(
  "C:\Users\xiao1\Mio\澪Agent应用\live2d-desktop\main.js",
  "C:\Users\xiao1\Mio\_mio_orig\Mio-main\澪Agent应用\live2d-desktop\main.js"
)
foreach ($f in $files) {
  $t = [IO.File]::ReadAllText($f, (New-Object Text.UTF8Encoding($false)))
  $t = $t.Replace("v=20261009-src-v12", "v=20261009-src-v13")
  [IO.File]::WriteAllText($f, $t, (New-Object Text.UTF8Encoding($false)))
  "updated: $f"
}
node --check "C:\Users\xiao1\Mio\澪Agent应用\live2d-desktop\main.js"
"node --check OK"
$c = [IO.File]::ReadAllText("C:\Users\xiao1\Mio\澪Agent应用\live2d-desktop\main.js", (New-Object Text.UTF8Encoding($false)))
if ($c -match 'src-v13') { "src-v13 OK" } else { "src-v13 MISSING" }
