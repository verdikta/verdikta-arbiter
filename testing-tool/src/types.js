/**
 * @typedef {Object} ScenarioRecord
 * @property {string} scenario_id - Unique identifier for the scenario
 * @property {string} prompt - The decision prompt
 * @property {string} outcomes - Comma-separated list of possible outcomes
 * @property {string} attachment_archive - ZIP file containing attachments and manifest
 * @property {string} [expected_winner] - Expected winning outcome (optional)
 * @property {string} [tags] - Comma-separated tags (optional)
 * @property {string} [notes] - Additional notes (optional)
 */

/**
 * @typedef {Object} JuryConfig
 * @property {number} id - Unique jury identifier
 * @property {string} name - Human-readable jury name
 * @property {Array<ModelConfig>} models - AI models in this jury
 * @property {number} [iterations] - Number of deliberation iterations
 */

/**
 * @typedef {Object} ModelConfig
 * @property {string} AI_PROVIDER - Provider name (OpenAI, Anthropic, Ollama)
 * @property {string} AI_MODEL - Model name
 * @property {number} WEIGHT - Weight in final decision (0-1)
 * @property {number} [NO_COUNTS] - Number of times to run this model
 */

/**
 * @typedef {Object} TestResult
 * @property {string} scenario_id
 * @property {number} jury_id
 * @property {Array<ScoreOutcome>} scores - Final scores from AI node
 * @property {string} justification - AI-generated justification
 * @property {number} execution_time_ms - Time taken to execute
 * @property {string} timestamp - ISO timestamp of execution
 * @property {string} [error] - Error message if failed
 */

/**
 * @typedef {Object} ScoreOutcome
 * @property {string} outcome - The outcome name
 * @property {number} score - The score (0-1000000)
 */

/**
 * @typedef {Object} ToolConfig
 * @property {string} aiNodeUrl - URL of the AI node
 * @property {number} timeoutMs - Request timeout in milliseconds
 * @property {number} maxRetries - Maximum retry attempts
 * @property {string} logLevel - Logging level (error, warn, info, debug)
 */

/**
 * @typedef {Object} TestRun
 * @property {string} runId - Unique run identifier
 * @property {string} timestamp - ISO timestamp of run start
 * @property {Array<number>} juryIds - Jury IDs used in this run
 * @property {Array<string>} scenarioIds - Scenario IDs executed
 * @property {Array<TestResult>} results - All test results
 * @property {RunStatistics} statistics - Aggregated statistics
 */

/**
 * @typedef {Object} RunStatistics
 * @property {number} totalScenarios - Total scenarios executed
 * @property {number} totalJuries - Total juries tested
 * @property {number} successfulTests - Number of successful executions
 * @property {number} failedTests - Number of failed executions
 * @property {number} averageExecutionTime - Average execution time in ms
 * @property {Object} juryAgreement - Agreement statistics between juries
 */

module.exports = {
  // Export types for JSDoc usage
}; 