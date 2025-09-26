#!/usr/bin/env node

/**
 * Verdikta Aggregator Contract Event Analysis Script
 * 
 * This script analyzes the ReputationAggregator smart contract to investigate
 * why commit-reveal cycles are not completing properly.
 * 
 * Usage:
 *   node analyze-aggregator-events.js [options]
 * 
 * Options:
 *   --contract=<address>     Contract address (default: 0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089)
 *   --rpc=<url>             RPC endpoint URL
 *   --from-block=<number>   Start block number (default: latest - 1000)
 *   --to-block=<number>     End block number (default: latest)
 *   --agg-id=<id>           Specific aggregation ID to analyze
 *   --detailed              Show detailed transaction analysis
 *   --help                  Show this help message
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Contract ABI (minimal - only events we need)
const AGGREGATOR_ABI = [
  "event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)",
  "event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash)",
  "event CommitPhaseComplete(bytes32 indexed aggRequestId)",
  "event RevealRequestDispatched(bytes32 indexed aggRequestId, uint256 pollIndex, bytes16 commitHash)",
  "event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, bytes32 indexed aggRequestId, address operator)",
  "event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)",
  "event EvaluationTimedOut(bytes32 indexed aggRequestId)",
  "event EvaluationFailed(bytes32 indexed aggRequestId, string phase)",
  "event RevealHashMismatch(bytes32 indexed aggRequestId, uint256 indexed pollIndex, address operator, bytes16 expectedHash, bytes16 gotHash)",
  
  // View functions
  "function aggregatedEvaluations(bytes32) view returns (bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredResponses, uint256 clusterSize, uint256[] aggregatedLikelihoods, bool userFunded, address requester, uint256 startTimestamp, string combinedJustificationCIDs, bool isComplete, bool failed)",
  "function responseTimeoutSeconds() view returns (uint256)",
  "function commitOraclesToPoll() view returns (uint256)",
  "function oraclesToPoll() view returns (uint256)",
  "function requiredResponses() view returns (uint256)"
];

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};

args.forEach(arg => {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=');
    options[key] = value || true;
  }
});

// Default values
const CONTRACT_ADDRESS = options.contract || '0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089';
const RPC_URL = options.rpc || process.env.RPC_URL || 'https://mainnet.base.org';
const DETAILED = options.detailed || false;
const TARGET_AGG_ID = options['agg-id'];

// Help text
if (options.help) {
  console.log(`
Verdikta Aggregator Contract Event Analysis

Usage: node analyze-aggregator-events.js [options]

Options:
  --contract=<address>     Contract address (default: 0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089)
  --rpc=<url>             RPC endpoint URL (default: https://mainnet.base.org)
  --from-block=<number>   Start block number (default: latest - 1000)
  --to-block=<number>     End block number (default: latest)
  --agg-id=<id>           Specific aggregation ID to analyze
  --detailed              Show detailed transaction analysis
  --help                  Show this help message

Environment Variables:
  RPC_URL                 Default RPC endpoint if not specified

Examples:
  # Analyze recent events
  node analyze-aggregator-events.js

  # Analyze specific aggregation ID
  node analyze-aggregator-events.js --agg-id=0x00e7983c8aead8b680bd264427fe638447747e46b4d3729e84c16bc577e14f5b

  # Detailed analysis with custom RPC
  node analyze-aggregator-events.js --rpc=https://base-mainnet.g.alchemy.com/v2/YOUR-KEY --detailed
`);
  process.exit(0);
}

class AggregatorAnalyzer {
  constructor(contractAddress, rpcUrl) {
    this.contractAddress = contractAddress;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.contract = new ethers.Contract(contractAddress, AGGREGATOR_ABI, this.provider);
    this.evaluations = new Map();
  }

  async analyze() {
    try {
      console.log(`🔍 Analyzing Aggregator Contract: ${this.contractAddress}`);
      console.log(`🌐 RPC Endpoint: ${this.provider.connection.url}`);
      
      // Get current block
      const currentBlock = await this.provider.getBlockNumber();
      console.log(`📦 Current Block: ${currentBlock}`);
      
      // Set block range
      const fromBlock = parseInt(options['from-block']) || currentBlock - 1000;
      const toBlock = parseInt(options['to-block']) || currentBlock;
      
      console.log(`📊 Analyzing blocks ${fromBlock} to ${toBlock}`);
      
      // Get contract configuration
      await this.getContractConfig();
      
      // Fetch all relevant events
      await this.fetchEvents(fromBlock, toBlock);
      
      // Analyze evaluations
      this.analyzeEvaluations();
      
    } catch (error) {
      console.error('❌ Analysis failed:', error.message);
      if (DETAILED) {
        console.error('Stack trace:', error.stack);
      }
      process.exit(1);
    }
  }

  async getContractConfig() {
    try {
      console.log('\n📋 CONTRACT CONFIGURATION:');
      console.log('─'.repeat(50));
      
      const config = await Promise.all([
        this.contract.commitOraclesToPoll(),
        this.contract.oraclesToPoll(), 
        this.contract.requiredResponses(),
        this.contract.responseTimeoutSeconds()
      ]);
      
      console.log(`K (Commit Oracles): ${config[0]}`);
      console.log(`M (Reveal Threshold): ${config[1]}`);
      console.log(`N (Required Responses): ${config[2]}`);
      console.log(`Timeout: ${config[3]} seconds`);
      
    } catch (error) {
      console.warn('⚠️ Could not fetch contract configuration:', error.message);
    }
  }

  async fetchEvents(fromBlock, toBlock) {
    console.log('\n🔍 FETCHING EVENTS:');
    console.log('─'.repeat(50));
    
    const eventTypes = [
      'RequestAIEvaluation',
      'CommitReceived', 
      'CommitPhaseComplete',
      'RevealRequestDispatched',
      'NewOracleResponseRecorded',
      'FulfillAIEvaluation',
      'EvaluationTimedOut',
      'EvaluationFailed',
      'RevealHashMismatch'
    ];

    for (const eventType of eventTypes) {
      try {
        console.log(`📡 Fetching ${eventType} events...`);
        const filter = this.contract.filters[eventType]();
        const events = await this.contract.queryFilter(filter, fromBlock, toBlock);
        
        console.log(`   Found ${events.length} ${eventType} events`);
        
        // Process events
        for (const event of events) {
          this.processEvent(event);
        }
        
      } catch (error) {
        console.warn(`⚠️ Error fetching ${eventType} events:`, error.message);
      }
    }
  }

  processEvent(event) {
    const aggId = event.args.aggRequestId || event.args.aggId;
    if (!aggId) return;
    
    const aggIdStr = aggId.toString();
    
    if (!this.evaluations.has(aggIdStr)) {
      this.evaluations.set(aggIdStr, {
        aggId: aggIdStr,
        request: null,
        commits: [],
        commitPhaseComplete: false,
        revealRequests: [],
        reveals: [],
        completion: null,
        timeout: null,
        failure: null,
        errors: []
      });
    }
    
    const evaluation = this.evaluations.get(aggIdStr);
    
    switch (event.event) {
      case 'RequestAIEvaluation':
        evaluation.request = {
          blockNumber: event.blockNumber,
          timestamp: null, // Will be filled when we get block
          cids: event.args.cids,
          transactionHash: event.transactionHash
        };
        break;
        
      case 'CommitReceived':
        evaluation.commits.push({
          pollIndex: event.args.pollIndex.toString(),
          operator: event.args.operator,
          commitHash: event.args.commitHash,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        });
        break;
        
      case 'CommitPhaseComplete':
        evaluation.commitPhaseComplete = {
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        };
        break;
        
      case 'RevealRequestDispatched':
        evaluation.revealRequests.push({
          pollIndex: event.args.pollIndex.toString(),
          commitHash: event.args.commitHash,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        });
        break;
        
      case 'NewOracleResponseRecorded':
        evaluation.reveals.push({
          requestId: event.args.requestId,
          pollIndex: event.args.pollIndex.toString(),
          operator: event.args.operator,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        });
        break;
        
      case 'FulfillAIEvaluation':
        evaluation.completion = {
          aggregated: event.args.aggregated,
          justifications: event.args.justifications,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        };
        break;
        
      case 'EvaluationTimedOut':
        evaluation.timeout = {
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        };
        break;
        
      case 'EvaluationFailed':
        evaluation.failure = {
          phase: event.args.phase,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        };
        break;
        
      case 'RevealHashMismatch':
        evaluation.errors.push({
          type: 'RevealHashMismatch',
          pollIndex: event.args.pollIndex.toString(),
          operator: event.args.operator,
          expectedHash: event.args.expectedHash,
          gotHash: event.args.gotHash,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        });
        break;
    }
  }

  analyzeEvaluations() {
    console.log('\n📊 EVALUATION ANALYSIS:');
    console.log('='.repeat(60));
    
    if (this.evaluations.size === 0) {
      console.log('❌ No evaluations found in the specified block range.');
      return;
    }
    
    let targetEvaluation = null;
    
    // If specific agg ID provided, focus on that
    if (TARGET_AGG_ID) {
      targetEvaluation = this.evaluations.get(TARGET_AGG_ID);
      if (!targetEvaluation) {
        console.log(`❌ Aggregation ID ${TARGET_AGG_ID} not found in the analyzed blocks.`);
        console.log('Available aggregation IDs:');
        for (const [aggId] of this.evaluations) {
          console.log(`  ${aggId}`);
        }
        return;
      }
      this.analyzeSpecificEvaluation(targetEvaluation);
    } else {
      // Analyze all evaluations
      console.log(`Found ${this.evaluations.size} evaluations:`);
      
      for (const [aggId, evaluation] of this.evaluations) {
        console.log(`\n🔍 Evaluation: ${aggId.substring(0, 20)}...`);
        this.analyzeSpecificEvaluation(evaluation);
      }
    }
  }

  analyzeSpecificEvaluation(evaluation) {
    console.log('\n📋 EVALUATION DETAILS:');
    console.log('─'.repeat(40));
    
    // Request info
    if (evaluation.request) {
      console.log(`📥 Request: Block ${evaluation.request.blockNumber}`);
      console.log(`   CIDs: ${evaluation.request.cids.length} items`);
      console.log(`   Tx: ${evaluation.request.transactionHash}`);
    }
    
    // Commit analysis
    console.log(`\n💾 COMMITS: ${evaluation.commits.length} received`);
    if (evaluation.commits.length > 0) {
      evaluation.commits.sort((a, b) => parseInt(a.pollIndex) - parseInt(b.pollIndex));
      evaluation.commits.forEach(commit => {
        console.log(`   Slot ${commit.pollIndex}: ${commit.operator.substring(0, 10)}... (Block ${commit.blockNumber})`);
        console.log(`     Hash: ${commit.commitHash}`);
        console.log(`     Tx: ${commit.transactionHash}`);
      });
    }
    
    // Commit phase completion
    console.log(`\n🎯 COMMIT PHASE COMPLETE: ${evaluation.commitPhaseComplete ? '✅ YES' : '❌ NO'}`);
    if (evaluation.commitPhaseComplete) {
      console.log(`   Block: ${evaluation.commitPhaseComplete.blockNumber}`);
      console.log(`   Tx: ${evaluation.commitPhaseComplete.transactionHash}`);
    }
    
    // Reveal requests
    console.log(`\n📤 REVEAL REQUESTS: ${evaluation.revealRequests.length} dispatched`);
    if (evaluation.revealRequests.length > 0) {
      evaluation.revealRequests.forEach(reveal => {
        console.log(`   Slot ${reveal.pollIndex}: Hash ${reveal.commitHash} (Block ${reveal.blockNumber})`);
        console.log(`     Tx: ${reveal.transactionHash}`);
      });
    }
    
    // Reveals received
    console.log(`\n📥 REVEALS: ${evaluation.reveals.length} received`);
    if (evaluation.reveals.length > 0) {
      evaluation.reveals.forEach(reveal => {
        console.log(`   Slot ${reveal.pollIndex}: ${reveal.operator.substring(0, 10)}... (Block ${reveal.blockNumber})`);
        console.log(`     Tx: ${reveal.transactionHash}`);
      });
    }
    
    // Completion status
    if (evaluation.completion) {
      console.log(`\n✅ COMPLETED: Block ${evaluation.completion.blockNumber}`);
      console.log(`   Aggregated: [${evaluation.completion.aggregated.join(', ')}]`);
      console.log(`   Tx: ${evaluation.completion.transactionHash}`);
    } else if (evaluation.timeout) {
      console.log(`\n⏰ TIMED OUT: Block ${evaluation.timeout.blockNumber}`);
      console.log(`   Tx: ${evaluation.timeout.transactionHash}`);
    } else if (evaluation.failure) {
      console.log(`\n❌ FAILED: Phase '${evaluation.failure.phase}' at Block ${evaluation.failure.blockNumber}`);
      console.log(`   Tx: ${evaluation.failure.transactionHash}`);
    } else {
      console.log(`\n⏳ STATUS: In progress or incomplete`);
    }
    
    // Error analysis
    if (evaluation.errors.length > 0) {
      console.log(`\n⚠️ ERRORS: ${evaluation.errors.length} found`);
      evaluation.errors.forEach(error => {
        console.log(`   ${error.type}: Slot ${error.pollIndex} (Block ${error.blockNumber})`);
        if (error.type === 'RevealHashMismatch') {
          console.log(`     Expected: ${error.expectedHash}`);
          console.log(`     Got: ${error.gotHash}`);
        }
      });
    }
    
    // Diagnostic analysis
    this.diagnoseIssues(evaluation);
  }

  diagnoseIssues(evaluation) {
    console.log(`\n🩺 DIAGNOSTIC ANALYSIS:`);
    console.log('─'.repeat(30));
    
    const issues = [];
    const insights = [];
    
    // Check commit phase
    if (evaluation.commits.length === 0) {
      issues.push('❌ No commits received');
    } else if (evaluation.commits.length < 4) {
      issues.push(`⚠️ Only ${evaluation.commits.length}/4 commits received (below M threshold)`);
    } else {
      insights.push(`✅ ${evaluation.commits.length} commits received (≥4 threshold)`);
    }
    
    // Check commit phase completion
    if (evaluation.commits.length >= 4 && !evaluation.commitPhaseComplete) {
      issues.push('🚨 CRITICAL: 4+ commits received but CommitPhaseComplete event missing');
      issues.push('   → Smart contract may have failed to trigger reveal phase');
    } else if (evaluation.commitPhaseComplete) {
      insights.push('✅ Commit phase completed successfully');
    }
    
    // Check reveal dispatch
    if (evaluation.commitPhaseComplete && evaluation.revealRequests.length === 0) {
      issues.push('🚨 CRITICAL: Commit phase complete but no reveal requests dispatched');
      issues.push('   → _dispatchRevealRequests() function may have failed');
    } else if (evaluation.revealRequests.length > 0) {
      insights.push(`✅ ${evaluation.revealRequests.length} reveal requests dispatched`);
    }
    
    // Check reveal responses
    if (evaluation.revealRequests.length > 0 && evaluation.reveals.length === 0) {
      issues.push('⚠️ Reveal requests sent but no reveals received');
      issues.push('   → External adapters may have failed to process Mode 2 requests');
    } else if (evaluation.reveals.length > 0) {
      insights.push(`✅ ${evaluation.reveals.length} reveals received`);
    }
    
    // Print results
    if (issues.length > 0) {
      console.log('🚨 ISSUES FOUND:');
      issues.forEach(issue => console.log(`  ${issue}`));
    }
    
    if (insights.length > 0) {
      console.log('\n✅ POSITIVE FINDINGS:');
      insights.forEach(insight => console.log(`  ${insight}`));
    }
    
    // Provide recommendations
    this.provideRecommendations(evaluation, issues);
  }

  provideRecommendations(evaluation, issues) {
    console.log(`\n💡 RECOMMENDATIONS:`);
    console.log('─'.repeat(25));
    
    if (issues.some(i => i.includes('CommitPhaseComplete event missing'))) {
      console.log('🔧 1. Check smart contract transaction that should have triggered CommitPhaseComplete');
      console.log('   - Look for transaction reverts or gas limit issues');
      console.log('   - Verify the 4th commit transaction succeeded completely');
    }
    
    if (issues.some(i => i.includes('no reveal requests dispatched'))) {
      console.log('🔧 2. Investigate _dispatchRevealRequests() function failure');
      console.log('   - Check if gas limit is sufficient for multiple Chainlink requests');
      console.log('   - Verify Chainlink node connectivity');
      console.log('   - Check for smart contract logic bugs');
    }
    
    if (issues.some(i => i.includes('no reveals received'))) {
      console.log('🔧 3. Check external adapter Mode 2 processing');
      console.log('   - Verify external adapters are receiving Mode 2 requests');
      console.log('   - Check Chainlink job configuration for reveal phase');
    }
    
    if (evaluation.commits.length >= 4 && !evaluation.commitPhaseComplete) {
      console.log('🔧 4. URGENT: Smart contract issue detected');
      console.log('   - The contract received enough commits but failed to progress');
      console.log('   - This suggests a bug in the smart contract logic or gas issues');
    }
  }

  async getTransactionDetails(txHash) {
    try {
      const tx = await this.provider.getTransaction(txHash);
      const receipt = await this.provider.getTransactionReceipt(txHash);
      
      return {
        hash: txHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        gasLimit: tx.gasLimit.toString(),
        status: receipt.status,
        successful: receipt.status === 1
      };
    } catch (error) {
      return {
        hash: txHash,
        error: error.message
      };
    }
  }
}

// Main execution
async function main() {
  console.log('🚀 Starting Verdikta Aggregator Analysis...\n');
  
  const analyzer = new AggregatorAnalyzer(CONTRACT_ADDRESS, RPC_URL);
  await analyzer.analyze();
  
  console.log('\n✅ Analysis complete!');
}

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled error:', error.message);
  if (DETAILED) {
    console.error('Stack trace:', error.stack);
  }
  process.exit(1);
});

main().catch(error => {
  console.error('❌ Script failed:', error.message);
  process.exit(1);
});



