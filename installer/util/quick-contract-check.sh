#!/bin/bash

# Quick Contract Analysis Script for Verdikta Aggregator
# Checks why commits are not triggering reveals

set -e

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
CONTRACT_ADDRESS="0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089"
AGG_ID="0x00e7983c8aead8b680bd264427fe638447747e46b4d3729e84c16bc577e14f5b"  # From your logs
RPC_URL="${RPC_URL:-https://sepolia.base.org}"  # Base Sepolia testnet

echo -e "${BLUE}🔍 Quick Aggregator Contract Analysis${NC}"
echo -e "${BLUE}Contract: $CONTRACT_ADDRESS${NC}"
echo -e "${BLUE}Aggregation ID: $AGG_ID${NC}"
echo -e "${BLUE}RPC: $RPC_URL${NC}"
echo ""

# Check if we have the necessary tools
if ! command -v cast >/dev/null 2>&1; then
    echo -e "${RED}❌ 'cast' command not found. Please install Foundry:${NC}"
    echo -e "${YELLOW}curl -L https://foundry.paradigm.xyz | bash${NC}"
    echo -e "${YELLOW}foundryup${NC}"
    exit 1
fi

echo -e "${BLUE}📋 Contract Configuration:${NC}"
echo "─────────────────────────────"

# Get contract configuration
echo -n "K (Commit Oracles): "
cast call $CONTRACT_ADDRESS "commitOraclesToPoll()(uint256)" --rpc-url $RPC_URL

echo -n "M (Reveal Threshold): "
cast call $CONTRACT_ADDRESS "oraclesToPoll()(uint256)" --rpc-url $RPC_URL

echo -n "N (Required Responses): "
cast call $CONTRACT_ADDRESS "requiredResponses()(uint256)" --rpc-url $RPC_URL

echo -n "Timeout (seconds): "
cast call $CONTRACT_ADDRESS "responseTimeoutSeconds()(uint256)" --rpc-url $RPC_URL

echo ""
echo -e "${BLUE}🔍 Aggregation State Analysis:${NC}"
echo "─────────────────────────────"

# Get aggregation state
echo -e "${YELLOW}Querying aggregation state for ID: $AGG_ID${NC}"

# The aggregatedEvaluations mapping returns multiple values
RESULT=$(cast call $CONTRACT_ADDRESS "aggregatedEvaluations(bytes32)(bool,uint256,uint256,uint256,uint256,uint256,uint256[],bool,address,uint256,string,bool,bool)" $AGG_ID --rpc-url $RPC_URL)

echo "Raw result: $RESULT"

# Parse the result (this is a simplified parser)
echo ""
echo -e "${BLUE}📊 Parsed Aggregation State:${NC}"
echo "Note: Manual parsing required for complex return values"
echo "Please check the blockchain explorer for detailed transaction analysis"

echo ""
echo -e "${BLUE}🔗 Useful Commands for Further Analysis:${NC}"
echo "─────────────────────────────────────────"
echo ""
echo -e "${YELLOW}1. Get recent CommitReceived events for your aggregation:${NC}"
echo "cast logs --from-block -200 --address $CONTRACT_ADDRESS --rpc-url $RPC_URL \\"
echo "  'CommitReceived(bytes32 indexed,uint256,address,bytes16)' $AGG_ID"
echo ""
echo -e "${YELLOW}2. Get CommitPhaseComplete events for your aggregation:${NC}"
echo "cast logs --from-block -200 --address $CONTRACT_ADDRESS --rpc-url $RPC_URL \\"
echo "  'CommitPhaseComplete(bytes32 indexed)' $AGG_ID"
echo ""
echo -e "${YELLOW}3. Get RevealRequestDispatched events for your aggregation:${NC}"
echo "cast logs --from-block -200 --address $CONTRACT_ADDRESS --rpc-url $RPC_URL \\"
echo "  'RevealRequestDispatched(bytes32 indexed,uint256,bytes16)' $AGG_ID"
echo ""
echo -e "${YELLOW}4. Check specific aggregation state:${NC}"
echo "cast call $CONTRACT_ADDRESS \\"
echo "  'aggregatedEvaluations(bytes32)' $AGG_ID --rpc-url $RPC_URL"
echo ""
echo -e "${YELLOW}5. Check recent blocks for failed transactions:${NC}"
echo "# Look for transactions to $CONTRACT_ADDRESS that failed"
echo "# Check gas usage and revert reasons"

echo ""
echo -e "${GREEN}💡 Analysis Steps:${NC}"
echo "1. Run the cast commands above to check events"
echo "2. If CommitReceived events exist but CommitPhaseComplete doesn't:"
echo "   → Smart contract failed to trigger reveal phase"
echo "3. If CommitPhaseComplete exists but no RevealRequestDispatched:"
echo "   → _dispatchRevealRequests() function failed"
echo "4. Check transaction receipts for gas issues or reverts"
