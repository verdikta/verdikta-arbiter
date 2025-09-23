#!/bin/bash

# WARNING: This script contains hardcoded addresses from a previous deployment
# After a clean install, these addresses may be outdated!
#
# TO UPDATE ADDRESSES AFTER CLEAN INSTALL:
# 1. Check your current operator address in: installer/.contracts (look for OPERATOR_ADDR)
# 2. Check your current node addresses in: installer/.contracts (look for KEY_*_ADDRESS)
# 3. Update the OPERATOR and NODES values below manually
# 4. Or use the dynamic approach by setting environment variables:
#    OPERATOR=0xYourOperatorAddress NODES=0xYourNode1,0xYourNode2 ./setAuthorizedSenders.sh

echo "⚠️  WARNING: Using hardcoded addresses from previous deployment"
echo "   If you've done a clean install, these may be outdated!"
echo "   Check installer/.contracts for current addresses"
echo ""

OPERATOR=0x5Eb49eC748a32f4094819bFb643937f8Cf295d3e \
NODES=0xA2944d1Dd73DB724d9bA31a80Ea240B5dF922498 \
npx hardhat run scripts/setAuthorizedSenders.js --network base_sepolia

