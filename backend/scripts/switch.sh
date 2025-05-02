#!/bin/bash

# backend/scripts/switch.sh
# Usage: ./switch.sh <environment> [--purge-cache]
# Switches traffic between blue and green environments by updating Netlify redirects

# Load environment variables
set -a
source ../../.env
set +a

# Validate arguments
if [[ $# -lt 1 ]]; then
  echo "Usage: ./switch.sh <environment> [--purge-cache]"
  echo "Environment must be 'blue' or 'green'"
  exit 1
fi

TARGET_ENV=$1
PURGE_CACHE=false

if [[ $# -gt 1 && $2 == "--purge-cache" ]]; then
  PURGE_CACHE=true
fi

# Validate environment
if [[ ! "$TARGET_ENV" =~ ^(blue|green)$ ]]; then
  echo "Error: Invalid environment '$TARGET_ENV'. Must be 'blue' or 'green'"
  exit 1
fi

# API endpoints
API_URL="http://localhost:3000/api/environments/switch"
NETLIFY_API_URL="https://api.netlify.com/api/v1/sites/$NETLIFY_SITE_ID/purge"

# Switch traffic
echo "Switching traffic to $TARGET_ENV environment..."
SWITCH_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "{\"targetBranch\":\"$TARGET_ENV\"}" \
  $API_URL)

# Check switch response
if [[ $(echo "$SWITCH_RESPONSE" | jq -r '.success') != "true" ]]; then
  echo "Error: Failed to switch traffic"
  echo "Response: $SWITCH_RESPONSE"
  exit 1
fi

echo "Successfully switched traffic to $TARGET_ENV"
echo "Redirects updated: $(echo "$SWITCH_RESPONSE" | jq -r '.redirects.rulesPreview')"

# Purge cache if requested
if [[ $PURGE_CACHE == true ]]; then
  echo "Purging Netlify cache..."
  PURGE_RESPONSE=$(curl -s -X POST \
    -H "Authorization: Bearer $NETLIFY_TOKEN" \
    -H "Content-Type: application/json" \
    $NETLIFY_API_URL)
  
  if [[ $(echo "$PURGE_RESPONSE" | jq -r '.ok') != "true" ]]; then
    echo "Warning: Cache purge failed"
    echo "Response: $PURGE_RESPONSE"
  else
    echo "Cache purged successfully"
  fi
fi

# Get final status
echo ""
echo "Current environment status:"
curl -s "$API_URL/status" | jq .

exit 0