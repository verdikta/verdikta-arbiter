#!/usr/bin/env node
'use strict';

/**
 * Generate a fresh, random wallet for use as the L4 E2E test wallet
 * (E2E_WALLET_PRIVATE_KEY). Intended to be run LOCALLY and never in CI.
 *
 * This script does not read or write any files, does not contact the network,
 * and does not log anything anywhere except stdout for you to copy once.
 *
 * Usage:
 *   node scripts/generate-wallet.js
 *   npm run generate-wallet
 */

const { ethers } = require('ethers');

const wallet = ethers.Wallet.createRandom();

console.log('\n=== New E2E test wallet generated ===\n');
console.log(`Address:     ${wallet.address}`);
console.log(`Private key: ${wallet.privateKey}`);
console.log(`Mnemonic:    ${wallet.mnemonic.phrase}`);
console.log('\nNext steps:');
console.log('  1. Fund ONLY this address with a small amount of Base Sepolia ETH');
console.log('     (see e2e/README.md "L4 test wallet" section for faucet links).');
console.log('  2. Copy the private key above into the GitHub "e2e" Environment secret');
console.log('     named E2E_WALLET_PRIVATE_KEY (Settings > Environments > e2e).');
console.log('  3. Do NOT commit this key, paste it into chat/issues/PRs, or reuse it');
console.log('     for anything other than this E2E harness.');
console.log('  4. Clear your terminal scrollback/history once the secret is saved.');
console.log('\nThis key is only ever generated locally — nothing above is persisted');
console.log('to disk or sent anywhere by this script.\n');
