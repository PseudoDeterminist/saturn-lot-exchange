#!/usr/bin/env bash
set -euo pipefail

SRC="/opt/saturn-lot-exchange/ui/"
DST="/var/www/saturn/"

echo "Deploying UI:"
echo "  $SRC"
echo "    -> $DST"

rsync -av --delete "$SRC" "$DST"

echo
echo "Verifying deployed files..."
diff -qr "$SRC" "$DST"

echo
echo "UI deployment complete."
