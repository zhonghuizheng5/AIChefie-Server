#!/bin/zsh
cd "$(dirname "$0")"

echo "Starting CookLens local AI server..."
echo "Keep this Terminal window open while testing the app."
echo

npm start

echo
echo "CookLens server stopped. Press Return to close this window."
read
