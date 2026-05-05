#!/bin/bash
# prep-new-year.sh — Pre-create year directories under Fam and Vault month trees
# Run as root on each NAS (noah, iolo, jaana) on Jan 1 of each year
# Usage: sudo bash prep-new-year.sh [YEAR]
# Default: current year

YEAR=${1:-$(date +%Y)}
OWNER="philander"
GROUP="users"
MODE="775"

MONTHS=(
  "January" "February" "March" "April" "May" "June"
  "July" "August" "September" "October" "November" "December"
)

echo "Creating $YEAR directories under Fam and Vault month trees..."

for BASE in "/volume1/RFA/Fam" "/volume1/RFA/Vault"; do
  for MONTH in "${MONTHS[@]}"; do
    DIR="$BASE/$MONTH/$YEAR"
    if [ -d "$DIR" ]; then
      echo "  Exists: $DIR"
    else
      mkdir -p "$DIR"
      chown "$OWNER:$GROUP" "$DIR"
      chmod "$MODE" "$DIR"
      echo "  Created: $DIR"
    fi
  done
done

echo "Complete."
ash-4.4# 

