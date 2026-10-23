#!/usr/bin/env bash
# Install (first time) and start Annotate Studio.  Usage: ./run-mac-linux.sh
set -e
cd "$(dirname "$0")"
npm install
npm run app
