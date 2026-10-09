$dir = "C:\Users\xiao1\Mio\澪Agent应用\dist\assets"
$files = Get-ChildItem -Path $dir -Filter "CompanionPage-*.js"
foreach ($f in $files) {
  Write-Output ("chunk: " + $f.Name)
  $c = [IO.File]::ReadAllText($f.FullName, (New-Object Text.UTF8Encoding($false)))
  Write-Output ("  observe_enabled: " + ($c -match "observe_enabled"))
  Write-Output ("  vision-info: " + ($c -match "vision-info"))
}
Write-Output "done"
