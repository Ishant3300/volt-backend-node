#!/bin/bash
# Dev script: ensures Redis is running, then starts nodemon.
# On exit (Ctrl+C), stops Redis only if we started it.

STARTED_REDIS=false

cleanup() {
  echo ""
  if [ "$STARTED_REDIS" = true ]; then
    echo "🛑 Shutting down Redis..."
    redis-cli shutdown nosave 2>/dev/null
    echo "✅ Redis stopped."
  fi
  echo "Bye!"
  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# Check if Redis is already running
if redis-cli ping > /dev/null 2>&1; then
  echo "✅ Redis already running, reusing it"
else
  echo "🚀 Starting Redis..."
  redis-server --daemonize yes --loglevel warning
  STARTED_REDIS=true
  sleep 0.5

  if redis-cli ping > /dev/null 2>&1; then
    echo "✅ Redis started"
  else
    echo "❌ Redis failed to start"
    exit 1
  fi
fi

# Start the Node server with nodemon
echo "🚀 Starting Node server..."
npx nodemon src/index.js
