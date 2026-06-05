# run.ps1 — avvia il mock DDS discovery server e poi lancia il mapper in modalità auto
# Uso: .\test\run.ps1

$root = Split-Path $PSScriptRoot -Parent

# Avvia il mock server in background
$serverJob = Start-Job -ScriptBlock {
    param($r)
    node "$r\test\mock-discovery-server.js"
} -ArgumentList $root

Write-Host "[run] Mock server avviato (job id: $($serverJob.Id))"

# Attendi che il server sia pronto
Start-Sleep -Seconds 1

# Lancia il mapper puntando all'endpoint del mock server
Write-Host "[run] Avvio dds-ngsi-mapper --auto ..."
node "$root\src\index.js" `
    --discovery-url "http://localhost:8080/api/discovery" `
    --auto `
    --out-config  "$root\test\out\dds-config.json" `
    --out-context "$root\test\out\dds-context.jsonld"

# Ferma il server
Stop-Job  $serverJob
Remove-Job $serverJob

Write-Host ""
Write-Host "[run] Output scritto in test\out\"
Write-Host "  test\out\dds-config.json"
Write-Host "  test\out\dds-context.jsonld"
