#!/bin/bash
# stream/start.sh — start pump.fun live stream via ffmpeg

set -e

PIDFILE="$(dirname "$0")/stream.pid"

if [ -f "$PIDFILE" ]; then
  echo "[stream] already running (pid $(cat $PIDFILE))"
  exit 0
fi

if [ -z "$PUMPFUN_STREAM_KEY" ]; then
  echo "[stream] PUMPFUN_STREAM_KEY not set — skipping stream"
  exit 0
fi

RTMP_URL="rtmp://stream.pump.fun/live/${PUMPFUN_STREAM_KEY}"

OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  # macOS: capture display 1 (adjust index if needed)
  ffmpeg \
    -f avfoundation -framerate 30 -i "1:0" \
    -vcodec libx264 -preset veryfast -tune zerolatency \
    -b:v 2500k -maxrate 2500k -bufsize 5000k \
    -acodec aac -b:a 128k \
    -f flv "$RTMP_URL" \
    > /tmp/stream.log 2>&1 &
else
  # Linux: capture display :0
  ffmpeg \
    -f x11grab -framerate 30 -video_size 1920x1080 -i :0 \
    -f alsa -i default \
    -vcodec libx264 -preset veryfast -tune zerolatency \
    -b:v 2500k -maxrate 2500k -bufsize 5000k \
    -acodec aac -b:a 128k \
    -f flv "$RTMP_URL" \
    > /tmp/stream.log 2>&1 &
fi

echo $! > "$PIDFILE"
echo "[stream] started (pid $!), streaming to pump.fun"
