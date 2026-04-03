#!/bin/bash
# Patch hermes-paperclip-adapter to inject auth tokens into Hermes agent runs
# This runs post-install to fix the npm package until upstream fixes it

ADAPTER_FILE=$(find node_modules -path "*/hermes-paperclip-adapter/dist/server/execute.js" -not -path "*/.pnpm/*" 2>/dev/null | head -1)
if [ -z "$ADAPTER_FILE" ]; then
  ADAPTER_FILE=$(find node_modules/.pnpm -path "*/hermes-paperclip-adapter/dist/server/execute.js" 2>/dev/null | head -1)
fi

if [ -z "$ADAPTER_FILE" ]; then
  echo "hermes-paperclip-adapter not found, skipping patch"
  exit 0
fi

echo "Patching $ADAPTER_FILE..."

# 1. Inject PAPERCLIP_API_KEY from ctx.authToken into env
if ! grep -q "ctx.authToken" "$ADAPTER_FILE"; then
  sed -i '/if (ctx.runId)/i\    if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;' "$ADAPTER_FILE"
  echo "  Added authToken → PAPERCLIP_API_KEY injection"
fi

# 2. Add Authorization header to all curl commands in the prompt template
if ! grep -q 'Authorization.*Bearer.*PAPERCLIP_API_KEY' "$ADAPTER_FILE"; then
  sed -i 's|curl -s |curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" |g' "$ADAPTER_FILE"
  echo "  Added auth headers to curl commands"
fi

echo "Hermes adapter patched successfully"

# 3. Fix timeout=0 treated as "use default 300s" (|| vs ??)
if grep -q 'cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC' "$ADAPTER_FILE"; then
  sed -i 's/cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC/cfgNumber(config.timeoutSec) ?? DEFAULT_TIMEOUT_SEC/' "$ADAPTER_FILE"
  echo "  Fixed timeout=0 bug (|| → ??)"
fi

# 4. Remove python3 pipe from curl commands (tirith blocks curl|python3)
if grep -q 'python3 -m json.tool' "$ADAPTER_FILE"; then
  sed -i 's/ | python3 -m json.tool//g' "$ADAPTER_FILE"
  sed -i "s/ | python3 -c .*\"//g" "$ADAPTER_FILE"
  echo "  Removed python3 pipes from curl commands"
fi
