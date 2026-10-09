$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\xiao1\Mio\澪Agent应用'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'vite build failed' }
Write-Output 'FRONTEND_BUILD_DONE'
