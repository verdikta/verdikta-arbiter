#!/bin/bash

# Simple event checker using curl and RPC calls
# No dependencies required

set -e

# Configuration
CONTRACT_ADDRESS="0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089"
AGG_ID="0x00e7983c8aead8b680bd264427fe638447747e46b4d3729e84c16bc577e14f5b"
RPC_URL="https://sepolia.base.org"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔍 Simple Event Analysis for Verdikta Aggregator${NC}"
echo -e "${BLUE}Contract: $CONTRACT_ADDRESS${NC}"
echo -e "${BLUE}Aggregation ID: $AGG_ID${NC}"
echo ""

# Get current block number
echo -e "${BLUE}📦 Getting current block number...${NC}"
CURRENT_BLOCK=$(curl -s -X POST $RPC_URL \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | \
  python3 -c "import sys, json; print(int(json.load(sys.stdin)['result'], 16))")

echo "Current block: $CURRENT_BLOCK"

# Calculate from block (200 blocks back)
FROM_BLOCK=$((CURRENT_BLOCK - 200))
FROM_BLOCK_HEX=$(printf "0x%x" $FROM_BLOCK)
TO_BLOCK_HEX=$(printf "0x%x" $CURRENT_BLOCK)

echo "Searching from block $FROM_BLOCK ($FROM_BLOCK_HEX) to $CURRENT_BLOCK ($TO_BLOCK_HEX)"
echo ""

# Event topic hashes (keccak256 of event signatures)
# CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash)
COMMIT_RECEIVED_TOPIC="0x$(echo -n 'CommitReceived(bytes32,uint256,address,bytes16)' | openssl dgst -sha3-256 | cut -d' ' -f2)"

# CommitPhaseComplete(bytes32 indexed aggRequestId)  
COMMIT_PHASE_COMPLETE_TOPIC="0x$(echo -n 'CommitPhaseComplete(bytes32)' | openssl dgst -sha3-256 | cut -d' ' -f2)"

# RevealRequestDispatched(bytes32 indexed aggRequestId, uint256 pollIndex, bytes16 commitHash)
REVEAL_DISPATCHED_TOPIC="0x$(echo -n 'RevealRequestDispatched(bytes32,uint256,bytes16)' | openssl dgst -sha3-256 | cut -d' ' -f2)"

echo -e "${BLUE}🔍 Checking for events...${NC}"

# Function to check for events
check_events() {
    local topic=$1
    local event_name=$2
    
    echo -e "${YELLOW}Checking $event_name events...${NC}"
    
    local response=$(curl -s -X POST $RPC_URL \
      -H "Content-Type: application/json" \
      -d "{
        \"jsonrpc\":\"2.0\",
        \"method\":\"eth_getLogs\",
        \"params\":[{
          \"address\":\"$CONTRACT_ADDRESS\",
          \"fromBlock\":\"$FROM_BLOCK_HEX\",
          \"toBlock\":\"$TO_BLOCK_HEX\",
          \"topics\":[\"$topic\", \"$AGG_ID\"]
        }],
        \"id\":1
      }")
    
    local count=$(echo "$response" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if 'result' in data:
        print(len(data['result']))
    else:
        print('Error:', data.get('error', 'Unknown error'))
        print(0)
except Exception as e:
    print('Parse error:', str(e))
    print(0)
" 2>/dev/null)
    
    echo "  $event_name: $count events found"
    
    if [ "$count" -gt 0 ] && [ "$count" != "Error:" ] && [ "$count" != "Parse" ]; then
        echo "  ✅ Events found for $event_name"
    else
        echo "  ❌ No events found for $event_name"
    fi
    
    return $count
}

# Check each event type
echo ""
check_events "$COMMIT_RECEIVED_TOPIC" "CommitReceived"
COMMIT_COUNT=$?

check_events "$COMMIT_PHASE_COMPLETE_TOPIC" "CommitPhaseComplete" 
COMPLETE_COUNT=$?

check_events "$REVEAL_DISPATCHED_TOPIC" "RevealRequestDispatched"
REVEAL_COUNT=$?

echo ""
echo -e "${BLUE}📋 ANALYSIS SUMMARY:${NC}"
echo "─".repeat(30)
echo "Commits received: $COMMIT_COUNT"
echo "Phase completed: $COMPLETE_COUNT"
echo "Reveals dispatched: $REVEAL_COUNT"

echo ""
echo -e "${BLUE}🩺 DIAGNOSIS:${NC}"
if [ "$COMMIT_COUNT" -eq 0 ]; then
    echo -e "${RED}❌ No commits found - aggregation ID may be incorrect${NC}"
elif [ "$COMMIT_COUNT" -lt 4 ]; then
    echo -e "${YELLOW}⚠️ Only $COMMIT_COUNT commits (need 4 to trigger reveals)${NC}"
else
    echo -e "${GREEN}✅ $COMMIT_COUNT commits received (≥4 threshold)${NC}"
    
    if [ "$COMPLETE_COUNT" -eq 0 ]; then
        echo -e "${RED}🚨 CRITICAL: CommitPhaseComplete event missing!${NC}"
        echo -e "${RED}   → Smart contract failed to trigger reveal phase${NC}"
        echo -e "${RED}   → Check the 4th commit transaction for issues${NC}"
    else
        echo -e "${GREEN}✅ Commit phase completed${NC}"
        
        if [ "$REVEAL_COUNT" -eq 0 ]; then
            echo -e "${RED}🚨 CRITICAL: No reveal requests dispatched!${NC}"
            echo -e "${RED}   → _dispatchRevealRequests() function failed${NC}"
        else
            echo -e "${GREEN}✅ $REVEAL_COUNT reveal requests dispatched${NC}"
        fi
    fi
fi

echo ""
echo -e "${BLUE}💡 Next Steps:${NC}"
echo "1. Check the BaseScan transaction events manually"
echo "2. Look for failed transactions around the time of the 4th commit"
echo "3. Check gas usage in the problematic transactions"


