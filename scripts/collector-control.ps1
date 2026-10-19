param([ValidateSet('Menu','Start','Stop','Status')][string]$Action = 'Menu')
$ErrorActionPreference = 'Stop'
$script:repo = Split-Path $PSScriptRoot -Parent
$script:worker = Join-Path $PSScriptRoot 'collector-worker.ps1'
$script:stateFile = Join-Path $script:repo '.local-state/collection-processes.json'
$script:settingsFile = Join-Path $script:repo '.local-state/collector-control.json'

function Read-CollectorRecord {
    $record = @{}
    if (Test-Path -LiteralPath $script:stateFile) {
        $value = Get-Content -Raw -LiteralPath $script:stateFile | ConvertFrom-Json
        foreach ($property in $value.PSObject.Properties) { $record[$property.Name] = $property.Value }
    }
    return $record
}
function Save-CollectorRecord([hashtable]$Record) {
    # A new checkout has no .local-state directory (it is intentionally gitignored).
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $script:stateFile)
    $temporary = $script:stateFile + '.' + $PID + '.tmp'
    $Record | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $temporary
    Move-Item -LiteralPath $temporary -Destination $script:stateFile -Force
}
function Get-ManagedWorker([ValidateSet('Capture','Sync','Branches')][string]$Role,[hashtable]$Record) {
    $key = $Role.ToLowerInvariant()
    $workerId = $Record[$key + 'Pid']
    $created = $Record[$key + 'StartedAt']
    if (-not $workerId -or -not $created) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$workerId)" -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    if ($process.CommandLine -notmatch [regex]::Escape($script:worker) -or $process.CommandLine -notmatch ('-Role\s+"?' + $Role + '\b')) { return $null }
    if ($process.CreationDate.ToString('o') -ne $created) { return $null }
    return $process
}
function Get-CollectorStatus {
    $record = Read-CollectorRecord
    $capture = Get-ManagedWorker -Role Capture -Record $record
    $sync = Get-ManagedWorker -Role Sync -Record $record
    $branches = Get-ManagedWorker -Role Branches -Record $record
    $configPresent = Test-Path -LiteralPath $script:settingsFile -PathType Leaf
    $secretsPresent = Test-Path -LiteralPath (Join-Path $script:repo '.wrangler/deployment-secrets.xml') -PathType Leaf
    return [PSCustomObject]@{captureRunning=[bool]$capture;syncRunning=[bool]$sync;branchesRunning=[bool]$branches;branchesPid=$(if($branches){$branches.ProcessId}else{$null});capturePid=$(if($capture){$capture.ProcessId}else{$null});syncPid=$(if($sync){$sync.ProcessId}else{$null});configPresent=[bool]$configPresent;secretsPresent=[bool]$secretsPresent}
}
function Start-Collector {
    if (-not (Test-Path -LiteralPath $script:settingsFile -PathType Leaf)) {
        throw 'Falta la configuracion local. Ejecuta: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collector-setup.ps1 -RunId TU_RUN_ID'
    }
    $config = Get-Content -Raw -LiteralPath $script:settingsFile | ConvertFrom-Json
    if (-not $config.manifest -or -not (Test-Path -LiteralPath $config.manifest -PathType Leaf)) { throw 'No se encuentra el catalogo de juegos configurado; comprueba .local-state/collector-control.json.' }
    $manifest = Get-Content -Raw -LiteralPath $config.manifest | ConvertFrom-Json
    if (-not $manifest.runId) { throw 'El manifiesto local no contiene runId.' }
    $secretPath = Join-Path $script:repo '.wrangler/deployment-secrets.xml'
    if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
        throw 'Faltan credenciales DPAPI locales (el git pull no las restaura). Si tienes los tokens existentes, ejecuta collector-setup.ps1 -ConfigureTokens; NO cambies los secretos del Worker.'
    }
    try {
        $localSecrets = Import-Clixml -LiteralPath $secretPath
        if (-not $localSecrets['INGEST_TOKEN'] -or -not $localSecrets['REVIEW_TOKEN']) { throw 'Claves de ingesta/revision ausentes' }
    } catch { throw 'Las credenciales DPAPI locales no son legibles por este usuario; recupera los tokens existentes en lugar de rotarlos automaticamente.' }
    Remove-Variable localSecrets
    $record = Read-CollectorRecord
    $hostPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    foreach ($role in @('Sync','Branches','Capture')) {
        if (Get-ManagedWorker -Role $role -Record $record) { continue }
        $key = $role.ToLowerInvariant()
        if ($record[$key+'Pid'] -and (Get-Process -Id ([int]$record[$key+'Pid']) -ErrorAction SilentlyContinue)) { throw 'Un PID guardado pertenece a otro proceso; no se modifico.' }
        $logPath = Join-Path $script:repo ('.local-state/' + $key + '-managed')
        $process = Start-Process -FilePath $hostPath -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$script:worker+'"'),'-Role',$role) -WorkingDirectory $script:repo -WindowStyle Hidden -RedirectStandardOutput ($logPath+'.stdout.log') -RedirectStandardError ($logPath+'.stderr.log') -PassThru
        $details = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
        if (-not $details) { throw "No se pudo iniciar $role. Revisar sus registros." }
        $record[$key+'Pid'] = $process.Id
        $record[$key+'StartedAt'] = $details.CreationDate.ToString('o')
        Save-CollectorRecord $record
    }
}
function Stop-Collector {
    $record = Read-CollectorRecord
    foreach ($role in @('Branches','Capture','Sync')) {
        $process = Get-ManagedWorker -Role $role -Record $record
        $key = $role.ToLowerInvariant()
        if ($process) {
            # Only our verified worker and its descendants, including its Chromium.
            $nativeProcess = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
            $null = & "$env:SystemRoot\System32\taskkill.exe" /PID $process.ProcessId /T /F 2>&1
            if ($nativeProcess -and -not $nativeProcess.WaitForExit(10000)) { throw "No se pudo detener $role." }
        } elseif ($record[$key+'Pid'] -and (Get-Process -Id ([int]$record[$key+'Pid']) -ErrorAction SilentlyContinue)) {
            throw 'El proceso guardado no es un worker propio; no se detuvo.'
        }
        $record.Remove($key+'Pid'); $record.Remove($key+'StartedAt')
        Save-CollectorRecord $record
    }
}
function Invoke-CollectorAction([string]$RequestedAction) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $name = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:repo.ToLowerInvariant())))).Replace('-','') } finally { $hash.Dispose() }
    $mutex = New-Object Threading.Mutex($false, ('Local\HybridCollector'+$name))
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Ya hay otra operacion del recopilador en curso.' }
        if ($RequestedAction -eq 'Start') { Start-Collector }
        elseif ($RequestedAction -eq 'Stop') { Stop-Collector }
    } finally { if ($acquired) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
function Show-CollectorMenu {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $form = New-Object Windows.Forms.Form
    $form.Text = 'Recopilador Hybrid Fuzzer'; $form.ClientSize = New-Object Drawing.Size(470,250)
    $form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false
    $label = New-Object Windows.Forms.Label
    $label.Location = New-Object Drawing.Point(24,22); $label.Size = New-Object Drawing.Size(420,76)
    $label.Font = New-Object Drawing.Font('Segoe UI',12)
    $form.Controls.Add($label)
    $note = New-Object Windows.Forms.Label
    $note.Location = New-Object Drawing.Point(24,160); $note.Size = New-Object Drawing.Size(420,54)
    $note.Text = "Se conserva el progreso al detener y reanudar.`r`nCerrar esta ventana deja el recopilador funcionando."
    $form.Controls.Add($note)
    $start = New-Object Windows.Forms.Button; $start.Text = 'Iniciar'; $start.Location = New-Object Drawing.Point(24,95); $start.Size = New-Object Drawing.Size(130,44)
    $stop = New-Object Windows.Forms.Button; $stop.Text = 'Detener'; $stop.Location = New-Object Drawing.Point(170,95); $stop.Size = New-Object Drawing.Size(130,44)
    $close = New-Object Windows.Forms.Button; $close.Text = 'Cerrar'; $close.Location = New-Object Drawing.Point(316,95); $close.Size = New-Object Drawing.Size(130,44)
    $form.Controls.AddRange(@($start,$stop,$close))
    $refresh = {
        try { $status = Get-CollectorStatus
            $label.Text = 'Captura: ' + $(if($status.captureRunning){'en marcha'}else{'detenida'}) + "`r`n" + 'Sincronizacion: ' + $(if($status.syncRunning){'en marcha'}else{'detenida'}) + "`r`n" + 'Ramas: ' + $(if($status.branchesRunning){'en marcha'}else{'detenida'})
            $start.Enabled = -not ($status.captureRunning -and $status.syncRunning -and $status.branchesRunning)
            $stop.Enabled = $status.captureRunning -or $status.syncRunning -or $status.branchesRunning
        } catch { $label.Text = 'Error al consultar el estado.' }
    }
    $start.Add_Click({ try { Invoke-CollectorAction 'Start'; & $refresh } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'Recopilador') | Out-Null } })
    $stop.Add_Click({ try { Invoke-CollectorAction 'Stop'; & $refresh } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'Recopilador') | Out-Null } })
    $close.Add_Click({$form.Close()})
    $timer = New-Object Windows.Forms.Timer; $timer.Interval = 3000; $timer.Add_Tick($refresh)
    $form.Add_Shown({ & $refresh; $timer.Start() })
    try { $null = $form.ShowDialog() } finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
}
if ($MyInvocation.InvocationName -ne '.') {
    if ($Action -eq 'Menu') { Show-CollectorMenu }
    else { if ($Action -ne 'Status') { Invoke-CollectorAction $Action }; Get-CollectorStatus | ConvertTo-Json -Compress }
}
