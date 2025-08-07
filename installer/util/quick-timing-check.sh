#!/bin/bash

# Quick Timing Check for Verdikta External Adapter
# Usage: ./scripts/quick-timing-check.sh [log-file] [min-time-ms]

LOG_FILE=${1:-"/var/log/verdikta-external-adapter.log"}
MIN_TIME=${2:-"5000"}

echo "🔍 Quick Timing Analysis for jobs taking longer than ${MIN_TIME}ms"
echo "================================================================"

if [[ ! -f "$LOG_FILE" ]]; then
    echo "❌ Log file not found: $LOG_FILE"
    exit 1
fi

# Use the timing parser to get a quick overview
node "$(dirname "$0")/parse-timing-logs.js" "$LOG_FILE" --min-time="$MIN_TIME" --detailed

echo ""
echo "📊 Summary of slow operations:"
echo "------------------------------"

# Extract timing patterns and show the slowest operations
grep -E "\[EA [^]]+\].*took [0-9]+ms" "$LOG_FILE" | \
    grep -E "took [0-9]{4,}ms" | \
    sed -E 's/.*\[EA ([^]]+)\] (.*)took ([0-9]+)ms.*/\3ms \1 \2/' | \
    sort -nr | \
    head -20

echo ""
echo "🚨 Jobs taking longer than ${MIN_TIME}ms:"
echo "----------------------------------------"

# Count jobs by mode that exceed threshold
grep -E "Total.*evaluation time: [0-9]+ms" "$LOG_FILE" | \
    sed -E 's/.*\[EA ([^ ]+) ([0-9]+)\].*Total.*evaluation time: ([0-9]+)ms.*/\3 \1 \2/' | \
    awk -v threshold="$MIN_TIME" '$1 > threshold {print $1 "ms", "Job:" $2, "Mode:" $3}' | \
    sort -nr

echo ""
echo "💡 Use the detailed scripts for more analysis:"
echo "   node scripts/analyze-timing.js --chart --threshold=$MIN_TIME"
echo "   node scripts/parse-timing-logs.js --format=csv --output=timing-data.csv"