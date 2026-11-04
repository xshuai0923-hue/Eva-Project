param(
    [ValidateSet('check', 'update')]
    [string]$Mode = 'check'
)

$ErrorActionPreference = 'Stop'
$bootstrapPath = Join-Path $PSScriptRoot '../bootstrap/openproject_bootstrap.rb'
$containerScript = '/tmp/eva-status-map-' + [guid]::NewGuid().ToString('N') + '.rb'

try {
    docker cp $bootstrapPath "eva-project-local-web-1:$containerScript"
    if ($LASTEXITCODE -ne 0) { throw 'Could not copy status mapping script.' }

    docker exec -e "EVAPROJECT_STATUS_MAP_ONLY=$Mode" eva-project-local-web-1 bundle exec rails runner $containerScript
    if ($LASTEXITCODE -ne 0) { throw 'Status mapping failed. Review the error above.' }

    if ($Mode -eq 'update') {
        docker restart eva-project-local-mcp-1
        if ($LASTEXITCODE -ne 0) { throw 'Mapping saved, but MCP restart failed.' }
    }
}
finally {
    docker exec -u 0 eva-project-local-web-1 rm -f $containerScript
}
