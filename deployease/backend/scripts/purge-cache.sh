#!/bin/bash

# backend/scripts/purge-cache.sh
# Usage: ./purge-cache.sh [environment] (optional, defaults to active branch)

# Load environment variables from .env
set -a
source ../../.env
set +a

# Determine target environment
TARGET_ENV=${1:-$(node -e "console.log(require('../server/services/redirectService').getActiveBranch().then(b => console.log(b)).catch(() => 'blue'))")}

# Validate environment
if [[ ! "$TARGET_ENV" =~ ^(blue|green)$ ]]; then
  echo "Error: Invalid environment '$TARGET_ENV'. Must be 'blue' or 'green'"
  exit 1
fi

# Netlify API endpoint
API_URL="https://api.netlify.com/api/v1/sites/$NETLIFY_SITE_ID/purge"

# Purge cache via Netlify API
echo "Purging Netlify cache for $TARGET_ENV environment..."
RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $NETLIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"branch\":\"$TARGET_ENV\"}" \
  $API_URL)

# Check response
if [[ "$RESPONSE" == *"\"ok\":true"* ]]; then
  echo "Success: Cache purged for $TARGET_ENV"
  exit 0
else
  echo "Error: Cache purge failed"
  echo "Response: $RESPONSE"
  exit 1
fi