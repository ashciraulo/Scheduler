#!/bin/bash
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  python3 serve.py
elif command -v python >/dev/null 2>&1; then
  python serve.py
elif command -v node >/dev/null 2>&1; then
  node serve.js
else
  echo "Neither Python nor Node.js was found on this PC."
  echo "Install one of them (python.org or nodejs.org), then run this file again."
  read -p "Press Enter to exit..."
fi
