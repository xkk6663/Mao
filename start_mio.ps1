# ============================================================
#  Mio 桌宠 一键启动脚本（后端 + Electron 桌宠）
#  用法: pwsh -NoProfile -ExecutionPolicy Bypass -File start_mio.ps1
#  幂等: 已在运行的服务会被跳过，不会重复启动
#  日志: C:\Users\xiao1\Mio\start_mio.log
#  说明: 所有子进程以 CreateNoWindow 启动（不附加控制台），
#        关闭启动终端不会影响桌宠/后端运行。
# ============================================================
$ErrorActionPreference = 'Stop'

$backendPy      = 'C:\Users\xiao1\Mio\私人AI日记系统\backend\.venv\Scripts\python.exe'
$backendDir     = 'C:\Users\xiao1\Mio\私人AI日记系统\backend'
$electronExe    = 'C:\Users\xiao1\Mio\澪Agent应用\live2d-desktop\node_modules\electron\dist\electron.exe'
$electronDir    = 'C:\Users\xiao1\Mio\澪Agent应用\live2d-desktop'
$outLog         = 'C:\Users\xiao1\Mio\backend_out.log'
$errLog         = 'C:\Users\xiao1\Mio\backend_err.log'
$startLog       = 'C:\Users\xiao1\Mio\start_mio.log'

function Write-Step($msg) {
    Write-Host $msg -ForegroundColor Cyan
    Add-Content -Path $startLog -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) -Encoding utf8
}

# 启动完全脱离控制台的子进程（CreateNoWindow，不继承父控制台）
$script:detachedProcs = New-Object System.Collections.ArrayList
function Start-Detached($exe, $argList, $workdir, $stdoutLog, $stderrLog) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $exe
    $psi.Arguments = $argList
    $psi.WorkingDirectory = $workdir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    if ($stdoutLog) { $psi.RedirectStandardOutput = $true }
    if ($stderrLog) { $psi.RedirectStandardError = $true }
    $proc = [System.Diagnostics.Process]::Start($psi)
    if ($stdoutLog) {
        $proc.OutputDataReceived += {
            param($s, $e)
            if ($e.Data) { Add-Content -Path $stdoutLog -Value $e.Data -Encoding utf8 }
        }
        $proc.BeginOutputReadLine()
    }
    if ($stderrLog) {
        $proc.ErrorDataReceived += {
            param($s, $e)
            if ($e.Data) { Add-Content -Path $stderrLog -Value $e.Data -Encoding utf8 }
        }
        $proc.BeginErrorReadLine()
    }
    [void]$script:detachedProcs.Add($proc)
    return $proc
}

# 用 WMI 启动（父进程=WmiPrvSE 系统服务）：彻底脱离脚本进程树，
# 关闭/杀掉启动终端、父脚本均不影响该进程存活
function Start-Wmi($exe, $argList, $workdir) {
    $cmdline = '"' + $exe + '" ' + $argList
    try {
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = $cmdline
            CurrentDirectory = $workdir
        }
        if ($r.ReturnValue -eq 0) { return $r.ProcessId }
        Write-Step "      WMI 启动返回 $($r.ReturnValue)，改用直接启动"
    } catch {
        Write-Step "      WMI 启动失败: $($_.Exception.Message)，改用直接启动"
    }
    $proc = Start-Process -FilePath $exe -WorkingDirectory $workdir -WindowStyle Hidden -PassThru
    return $proc.Id
}

Write-Step '========== Mio 桌宠启动 =========='

# ---------- 1) 后端 (uvicorn :8000) ----------
$backendUp = $false
try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/companion/status' -TimeoutSec 2; $backendUp = $true } catch {}

if ($backendUp) {
    Write-Step '[1/2] 后端已在运行，跳过'
} else {
    Write-Step '[1/2] 后端未运行，正在启动...'
    $p = Start-Detached $backendPy '-m uvicorn app.main:app --host 127.0.0.1 --port 8000' $backendDir $outLog $errLog
    Write-Step "      已启动 (pid=$($p.Id))，等待就绪..."
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 1000
        try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/companion/status' -TimeoutSec 1; $ready = $true; break } catch {}
    }
    if ($ready) { Write-Step '      后端就绪 OK' }
    else { Write-Step '      后端启动超时，请查看 backend_err.log' }
}

# ---------- 2) Electron 桌宠 ----------
$electronRunning = [bool](Get-Process -Name electron -ErrorAction SilentlyContinue)
if ($electronRunning) {
    Write-Step '[2/2] 桌宠已在运行，跳过'
} else {
    Write-Step '[2/2] 桌宠未运行，正在启动...'
    $petPid = Start-Wmi $electronExe '.' $electronDir
    Write-Step "      桌宠窗口已拉起 (pid=$petPid)，几秒内出现"
}

Write-Step '========== 完成 =========='
# 强制退出：Start-Detached 的异步事件处理器会阻止脚本自然结束；
# 用 Environment.Exit 强制终止进程，确保启动窗口立即关闭、不留窗口给用户误关
[Environment]::Exit(0)
