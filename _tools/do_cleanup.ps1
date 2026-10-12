# 删除 dist_backup、backend tests/scripts、清 __pycache__、QQ/UI测试脚本
$log = @()
$git = git -C "C:\Users\xiao1\Mio" rm -r "私人AI日记系统/backend/tests" "私人AI日记系统/backend/scripts"
$log += "backend tests+scripts: " + $git.Count + " files removed"

$git2 = git -C "C:\Users\xiao1\Mio" rm "澪Agent应用/scripts/启动QQ聊天.ps1" "澪Agent应用/scripts/停止QQ聊天.ps1" "澪Agent应用/scripts/重启NapCat.ps1" "澪Agent应用/scripts/napcat-control.ps1" "澪Agent应用/scripts/deps/install-napcat.ps1" `
  "澪Agent应用/scripts/agent-settings-preview.html" "澪Agent应用/scripts/control-surfaces-preview.html" "澪Agent应用/scripts/diary-recovery-preview.html" `
  "澪Agent应用/scripts/test_agent_custom_settings_ui.cjs" "澪Agent应用/scripts/test_agent_settings_ui.cjs" "澪Agent应用/scripts/test_control_surfaces_ui.cjs" `
  "澪Agent应用/scripts/test_diary_recovery_ui.cjs" "澪Agent应用/scripts/test_genie_tts_worker.py" "澪Agent应用/scripts/test_handoff_scope_ui.cjs" `
  "澪Agent应用/scripts/test_local_picker_ui.cjs" "澪Agent应用/scripts/test_local_vision_ui.cjs" "澪Agent应用/scripts/test_system_audio_worker.py"
$log += "QQ+UI tests: " + $git2.Count + " files removed"

# 物理删 dist_backup
if (Test-Path "C:\Users\xiao1\Mio\澪Agent应用\dist_backup_20261009") {
  Remove-Item "C:\Users\xiao1\Mio\澪Agent应用\dist_backup_20261009" -Recurse -Force
  $log += "dist_backup_20261009 deleted"
}

# 清 __pycache__
$pyc = Get-ChildItem "C:\Users\xiao1\Mio\私人AI日记系统\backend" -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue
foreach ($d in $pyc) { Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }
$log += "pycache dirs cleaned: " + $pyc.Count

# 删除本批次删除脚本自身（del_root_*.ps1 / scan*.ps1 等临时脚本）
foreach ($tmp in @("del_root_tracked.ps1","del_root_phys.ps1","scan_backend.ps1","scan_frontend.ps1","scan2.ps1","scan3.ps1","scan4.ps1","rm_root_tracked.txt")) {
  $p = "C:\Users\xiao1\Mio\$tmp"
  if (Test-Path $p) { Remove-Item $p -Force; $log += "tmp removed: $tmp" }
}

$log | Set-Content "C:\Users\xiao1\Mio\cleanup_report.txt" -Encoding UTF8
