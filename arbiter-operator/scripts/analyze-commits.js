#!/usr/bin/env node

/**
 * Analyze commit-reveal cycle for Verdikta Aggregator
 * Uses Hardhat environment for blockchain analysis
 */

const hre = require("hardhat");
const { ethers } = hre;

// Configuration
const CONTRACT_ADDRESS = "0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089";
const AGG_ID = "0x00e7983c8aead8b680bd264427fe638447747e46b4d3729e84c16bc577e14f5b";

// Contract ABI for events
const AGGREGATOR_ABI = [
  "event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)",
  "event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash)",
  "event CommitPhaseComplete(bytes32 indexed aggRequestId)",
  "event RevealRequestDispatched(bytes32 indexed aggRequestId, uint256 pollIndex, bytes16 commitHash)",
  "event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, bytes32 indexed aggRequestId, address operator)",
  "event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)",
  "event EvaluationTimedOut(bytes32 indexed aggRequestId)",
  "event EvaluationFailed(bytes32 indexed aggRequestId, string phase)",
];

async function analyzeCommitReveal() {
  console.log("🔍 Analyzing Commit-Reveal Cycle");
  console.log("Contract:", CONTRACT_ADDRESS);
  console.log("Aggregation ID:", AGG_ID);
  console.log("Network: Base Sepolia");
  console.log("");

  try {
    // Get provider and contract
    const provider = ethers.provider;
    const contract = new ethers.Contract(CONTRACT_ADDRESS, AGGREGATOR_ABI, provider);
    
    // Get current block
    const currentBlock = await provider.getBlockNumber();
    console.log("📦 Current Block:", currentBlock);
    
    // Look back 1000 blocks for events
    const fromBlock = currentBlock - 1000;
    console.log("📊 Searching blocks", fromBlock, "to", currentBlock);
    console.log("");
    
    // Get all events for our aggregation ID
    console.log("🔍 FETCHING EVENTS FOR AGGREGATION:", AGG_ID.substring(0, 20) + "...");
    console.log("─".repeat(60));
    
    // 1. RequestAIEvaluation events
    const requestFilter = contract.filters.RequestAIEvaluation(AGG_ID);
    const requestEvents = await contract.queryFilter(requestFilter, fromBlock);
    console.log(`📥 RequestAIEvaluation: ${requestEvents.length} events`);
    
    // 2. CommitReceived events
    const commitFilter = contract.filters.CommitReceived(AGG_ID);
    const commitEvents = await contract.queryFilter(commitFilter, fromBlock);
    console.log(`💾 CommitReceived: ${commitEvents.length} events`);
    
    if (commitEvents.length > 0) {
      console.log("   Commits by slot:");
      commitEvents.forEach(event => {
        console.log(`     Slot ${event.args.pollIndex}: ${event.args.operator.substring(0, 12)}... Hash: ${event.args.commitHash}`);
      });
    }
    
    // 3. CommitPhaseComplete events
    const completeFilter = contract.filters.CommitPhaseComplete(AGG_ID);
    const completeEvents = await contract.queryFilter(completeFilter, fromBlock);
    console.log(`🎯 CommitPhaseComplete: ${completeEvents.length} events`);
    
    // 4. RevealRequestDispatched events
    const revealFilter = contract.filters.RevealRequestDispatched(AGG_ID);
    const revealEvents = await contract.queryFilter(revealFilter, fromBlock);
    console.log(`📤 RevealRequestDispatched: ${revealEvents.length} events`);
    
    // 5. NewOracleResponseRecorded events
    const responseFilter = contract.filters.NewOracleResponseRecorded(null, null, AGG_ID);
    const responseEvents = await contract.queryFilter(responseFilter, fromBlock);
    console.log(`📥 NewOracleResponseRecorded: ${responseEvents.length} events`);
    
    // 6. Completion/Failure events
    const fulfillFilter = contract.filters.FulfillAIEvaluation(AGG_ID);
    const fulfillEvents = await contract.queryFilter(fulfillFilter, fromBlock);
    console.log(`✅ FulfillAIEvaluation: ${fulfillEvents.length} events`);
    
    const timeoutFilter = contract.filters.EvaluationTimedOut(AGG_ID);
    const timeoutEvents = await contract.queryFilter(timeoutFilter, fromBlock);
    console.log(`⏰ EvaluationTimedOut: ${timeoutEvents.length} events`);
    
    const failedFilter = contract.filters.EvaluationFailed(AGG_ID);
    const failedEvents = await contract.queryFilter(failedFilter, fromBlock);
    console.log(`❌ EvaluationFailed: ${failedEvents.length} events`);
    
    console.log("");
    console.log("🩺 DIAGNOSIS:");
    console.log("─".repeat(30));
    
    // Analyze the flow
    if (commitEvents.length === 0) {
      console.log("❌ ISSUE: No commits found for this aggregation ID");
      console.log("   → Check if the aggregation ID is correct");
    } else if (commitEvents.length < 4) {
      console.log(`⚠️ ISSUE: Only ${commitEvents.length}/4 commits received`);
      console.log("   → Not enough commits to trigger reveal phase");
    } else {
      console.log(`✅ GOOD: ${commitEvents.length} commits received (≥4 threshold)`);
      
      if (completeEvents.length === 0) {
        console.log("🚨 CRITICAL ISSUE: CommitPhaseComplete event missing!");
        console.log("   → Smart contract failed to trigger reveal phase");
        console.log("   → Check the 4th commit transaction for gas issues or reverts");
      } else {
        console.log("✅ GOOD: Commit phase completed");
        
        if (revealEvents.length === 0) {
          console.log("🚨 CRITICAL ISSUE: No reveal requests dispatched!");
          console.log("   → _dispatchRevealRequests() function failed");
          console.log("   → Check gas limits or Chainlink node connectivity");
        } else {
          console.log(`✅ GOOD: ${revealEvents.length} reveal requests dispatched`);
          
          if (responseEvents.length === 0) {
            console.log("⚠️ ISSUE: No reveals received");
            console.log("   → External adapters failed to process Mode 2 requests");
            console.log("   → Check external adapter logs for Mode 2 processing");
          } else {
            console.log(`✅ GOOD: ${responseEvents.length} reveals received`);
          }
        }
      }
    }
    
    // Summary
    console.log("");
    console.log("📋 SUMMARY:");
    console.log(`   Commits: ${commitEvents.length}/6`);
    console.log(`   Phase Complete: ${completeEvents.length > 0 ? 'YES' : 'NO'}`);
    console.log(`   Reveals Requested: ${revealEvents.length}`);
    console.log(`   Reveals Received: ${responseEvents.length}`);
    console.log(`   Completed: ${fulfillEvents.length > 0 ? 'YES' : 'NO'}`);
    
  } catch (error) {
    console.error("❌ Analysis failed:", error.message);
    console.error("Stack trace:", error.stack);
  }
}

// Run the analysis
analyzeCommitReveal()
  .then(() => {
    console.log("\n✅ Analysis complete!");
    process.exit(0);
  })
  .catch(error => {
    console.error("❌ Script failed:", error.message);
    process.exit(1);
  });
