#!/bin/bash
set -euo pipefail

echo "=== Paperclip Platform Migration to Docker ==="
echo

# Step 1: Stop bare-metal services
echo "Step 1: Stopping bare-metal Paperclip services..."

# Stop PM2 process if it exists
if pm2 list 2>/dev/null | grep -q 'autogeny-platform'; then
  echo "  → Stopping PM2 process 'autogeny-platform'..."
  pm2 delete autogeny-platform || true
  pm2 save || true
fi

# Kill any bare-metal server processes
echo "  → Stopping any bare-metal server processes..."
pkill -f 'server/dist/index.js' || true
sleep 2

# Double-check nothing is listening on port 3100
if lsof -ti:3100 > /dev/null 2>&1; then
  echo "  ⚠ Warning: Port 3100 is still in use. Forcefully killing..."
  lsof -ti:3100 | xargs kill -9 || true
  sleep 1
fi

echo "  ✓ Bare-metal services stopped"
echo

# Step 2: Update DATABASE_URL for Docker networking
echo "Step 2: Updating DATABASE_URL for Docker container networking..."
ENV_FILE="/opt/autogeny-platform/.env"

if grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  # Replace localhost with docker-db-1 for container networking
  sed -i 's|^DATABASE_URL=.*|DATABASE_URL=postgres://paperclip:paperclip@docker-db-1:5432/paperclip|' "$ENV_FILE"
  echo "  ✓ DATABASE_URL updated to docker-db-1"
else
  echo "DATABASE_URL=postgres://paperclip:paperclip@docker-db-1:5432/paperclip" >> "$ENV_FILE"
  echo "  ✓ DATABASE_URL added to .env"
fi
echo

# Step 3: Build Docker image
echo "Step 3: Building Docker image..."
cd /opt/autogeny-platform
docker build -t autogeny-platform:latest .
echo "  ✓ Image built successfully"
echo

# Step 4: Start containers with environment file
echo "Step 4: Starting containerized Paperclip..."
cd /opt/autogeny-platform/docker
docker compose -f docker-compose.production.yml --env-file /opt/autogeny-platform/.env up -d
echo "  ✓ Containers started"
echo

# Step 5: Health check loop
echo "Step 5: Waiting for Paperclip to become healthy..."
MAX_ATTEMPTS=60
ATTEMPT=0
HEALTHY=false

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  ATTEMPT=$((ATTEMPT + 1))

  # Check if container is running
  if ! docker ps --filter 'name=autogeny-platform' --filter 'status=running' | grep -q autogeny-platform; then
    echo "  ⚠ Container not running yet (attempt $ATTEMPT/$MAX_ATTEMPTS)..."
    sleep 2
    continue
  fi

  # Check if the app responds on port 3100
  if curl -sf http://localhost:3100/api/health > /dev/null 2>&1; then
    HEALTHY=true
    break
  fi

  echo "  ⏳ Waiting for health check (attempt $ATTEMPT/$MAX_ATTEMPTS)..."
  sleep 2
done

echo
if [ "$HEALTHY" = true ]; then
  echo "✅ Migration complete! Paperclip is running in Docker."
  echo
  echo "Container status:"
  docker ps --filter 'name=autogeny-platform'
  echo
  echo "UID verification:"
  docker exec autogeny-platform whoami
  echo
  echo "View logs with:"
  echo "  docker logs -f autogeny-platform"
else
  echo "❌ Health check failed after $MAX_ATTEMPTS attempts."
  echo
  echo "Check container logs:"
  echo "  docker logs autogeny-platform"
  echo
  echo "Rollback with:"
  echo "  cd /opt/autogeny-platform/docker && docker compose -f docker-compose.production.yml down"
  echo "  # Then restart bare-metal: cd /opt/autogeny-platform && bash start.sh"
  docker ps -a --filter 'name=autogeny-platform'
  exit 1
fi
