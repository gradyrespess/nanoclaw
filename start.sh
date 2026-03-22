#!/bin/bash
# Start ngrok in the background
ngrok http 3002 &
sleep 2

# Start NanoClaw in the foreground
cd /home/gradyr830/nanoclaw
npm run dev
