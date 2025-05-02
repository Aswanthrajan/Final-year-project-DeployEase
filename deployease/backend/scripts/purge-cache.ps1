# backend/scripts/purge-cache.ps1
param(
    [string]$TargetEnv = ""
)

# Load environment variables
$envFile = Join-Path $PSScriptRoot "../../.env"
Get-Content $envFile | ForEach-Object {
    if ($_ -match "^\s*([^#]\w+)\s*=\s*(.*)\s*$") {
        Set-Item "env:\$($matches[1])" $matches[2]
    }
}

# Get active branch if not specified
if ([string]::IsNullOrEmpty($TargetEnv)) {
    $TargetEnv = (node -e "require('../server/services/redirectService').getActiveBranch().then(b => console.log(b)).catch(() => 'blue')").Trim()
}

# Validate environment
if ($TargetEnv -notin @("blue", "green")) {
    Write-Error "Invalid environment '$TargetEnv'. Must be 'blue' or 'green'"
    exit 1
}

# Netlify API call
$headers = @{
    "Authorization" = "Bearer $env:NETLIFY_TOKEN"
    "Content-Type" = "application/json"
}
$body = @{ branch = $TargetEnv } | ConvertTo-Json

Write-Host "Purging Netlify cache for $TargetEnv environment..."
try {
    $response = Invoke-RestMethod -Uri "https://api.netlify.com/api/v1/sites/$env:NETLIFY_SITE_ID/purge" `
        -Method Post `
        -Headers $headers `
        -Body $body

    if ($response.ok) {
        Write-Host "✅ Success: Cache purged for $TargetEnv"
        exit 0
    } else {
        throw "API returned failure status"
    }
} catch {
    Write-Error "❌ Cache purge failed: $_"
    exit 1
}