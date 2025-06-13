const axios = require('axios');
const logger = require('./logger');
const attachmentHandler = require('./attachment-handler');

/**
 * Test runner for executing scenarios against AI node
 */
class TestRunner {
  constructor(toolConfig) {
    this.config = toolConfig;
    this.client = axios.create({
      baseURL: toolConfig.aiNodeUrl,
      timeout: toolConfig.timeoutMs,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Execute a single scenario against a specific jury
   * @param {import('./types').ScenarioRecord} scenario
   * @param {import('./types').JuryConfig} jury
   * @returns {import('./types').TestResult}
   */
  async executeScenario(scenario, jury) {
    const startTime = Date.now();
    let tempDir = null;
    
    try {
      logger.info(`Executing scenario ${scenario.scenario_id} with jury ${jury.id} (${jury.name})`);

      let requestData, archiveTempDir;
      
      if (scenario.attachment_archive) {
        // Process archive and attachments with scenario data from CSV
        const result = await attachmentHandler.processArchive(
          scenario.attachment_archive,
          jury,
          scenario.prompt,
          scenario._parsedOutcomes
        );
        requestData = result.requestData;
        tempDir = result.tempDir;
      } else {
        // Create request data directly for scenarios without attachments
        logger.debug(`Scenario ${scenario.scenario_id} has no attachments - creating request without archive processing`);
        requestData = {
          prompt: scenario.prompt,
          outcomes: scenario._parsedOutcomes,
          models: this.convertJuryConfigToRequestFormat(jury),
          iterations: jury.iterations || 1,
          attachments: [] // Empty attachments array
        };
      }

      logger.debug(`Request data for ${scenario.scenario_id}:`, {
        prompt: requestData.prompt.substring(0, 100) + '...',
        outcomes: requestData.outcomes,
        models: requestData.models.map(m => `${m.provider}:${m.model}:${m.weight}`),
        iterations: requestData.iterations,
        attachments: requestData.attachments?.length || 0
      });

      // Execute against AI node
      const response = await this.callAINode(requestData);
      const executionTime = Date.now() - startTime;

      // Build result
      const result = {
        scenario_id: scenario.scenario_id,
        jury_id: jury.id,
        scores: response.scores || [],
        justification: response.justification || '',
        execution_time_ms: executionTime,
        timestamp: new Date().toISOString()
      };

      logger.info(`Scenario ${scenario.scenario_id} completed successfully in ${executionTime}ms`);
      return result;

    } catch (error) {
      const executionTime = Date.now() - startTime;
      logger.error(`Scenario ${scenario.scenario_id} failed:`, error);

      return {
        scenario_id: scenario.scenario_id,
        jury_id: jury.id,
        scores: [],
        justification: '',
        execution_time_ms: executionTime,
        timestamp: new Date().toISOString(),
        error: error.message
      };

    } finally {
      // Clean up temporary files
      if (tempDir) {
        await attachmentHandler.cleanup(tempDir);
      }
    }
  }

  /**
   * Execute multiple scenarios against multiple juries
   * @param {Array<import('./types').ScenarioRecord>} scenarios
   * @param {Array<import('./types').JuryConfig>} juries
   * @param {Function} [progressCallback] - Called with progress updates
   * @returns {Array<import('./types').TestResult>}
   */
  async executeScenarios(scenarios, juries, progressCallback) {
    const results = [];
    const totalTests = scenarios.length * juries.length;
    let completedTests = 0;

    logger.info(`Starting execution of ${scenarios.length} scenarios against ${juries.length} juries (${totalTests} total tests)`);

    for (const scenario of scenarios) {
      for (const jury of juries) {
        try {
          const result = await this.executeScenario(scenario, jury);
          results.push(result);
          completedTests++;

          if (progressCallback) {
            progressCallback({
              completed: completedTests,
              total: totalTests,
              percentage: Math.round((completedTests / totalTests) * 100),
              currentScenario: scenario.scenario_id,
              currentJury: jury.name,
              lastResult: result
            });
          }

          // Add small delay between requests to avoid overwhelming the AI node
          await this.delay(100);

        } catch (error) {
          logger.error(`Critical error in test execution:`, error);
          completedTests++;
          
          if (progressCallback) {
            progressCallback({
              completed: completedTests,
              total: totalTests,
              percentage: Math.round((completedTests / totalTests) * 100),
              currentScenario: scenario.scenario_id,
              currentJury: jury.name,
              error: error.message
            });
          }
        }
      }
    }

    logger.info(`Execution completed: ${completedTests}/${totalTests} tests finished`);
    return results;
  }

  /**
   * Call the AI node rank-and-justify endpoint
   * @param {Object} requestData - Request payload
   * @returns {Object} AI node response
   */
  async callAINode(requestData) {
    let retryCount = 0;
    const maxRetries = this.config.maxRetries;

    while (retryCount <= maxRetries) {
      try {
        logger.debug(`Calling AI node (attempt ${retryCount + 1}/${maxRetries + 1})`);
        
        const response = await this.client.post('/api/rank-and-justify', requestData);
        
        if (response.status === 200 && response.data) {
          logger.debug('AI node response received successfully');
          return response.data;
        } else {
          throw new Error(`Unexpected response status: ${response.status}`);
        }

      } catch (error) {
        retryCount++;
        
        if (retryCount > maxRetries) {
          // Log the full error details for debugging
          if (error.response) {
            logger.error('AI node response error:', {
              status: error.response.status,
              statusText: error.response.statusText,
              data: error.response.data
            });
            throw new Error(`AI node error: ${error.response.status} ${error.response.statusText} - ${JSON.stringify(error.response.data)}`);
          } else if (error.request) {
            logger.error('AI node request error:', error.message);
            throw new Error(`AI node connection error: ${error.message}`);
          } else {
            logger.error('AI node error:', error.message);
            throw new Error(`AI node error: ${error.message}`);
          }
        }

        // Wait before retry
        const waitTime = Math.min(1000 * Math.pow(2, retryCount - 1), 10000); // Exponential backoff, max 10s
        logger.warn(`AI node request failed (attempt ${retryCount}/${maxRetries + 1}), retrying in ${waitTime}ms...`);
        await this.delay(waitTime);
      }
    }
  }

  /**
   * Test AI node connectivity
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    try {
      logger.info(`Testing connection to AI node at ${this.config.aiNodeUrl}`);
      const response = await this.client.get('/api/health');
      logger.debug('AI node /api/health response:', response.data);
      if (response.status === 200 && response.data && response.data.status === 'ok') {
        logger.info('AI node health check successful');
        return true;
      } else {
        logger.warn(`AI node health check returned status ${response.status} with data: ${JSON.stringify(response.data)}`);
        return false;
      }
    } catch (error) {
      if (error.response) {
        logger.error(`AI node health check failed with status ${error.response.status}`);
      } else {
        logger.error('AI node health check failed:', error.message);
      }
      return false;
    }
  }

  /**
   * Get health information from AI node
   * @returns {Object|null}
   */
  async getHealthInfo() {
    try {
      // Try common health endpoints
      const healthEndpoints = ['/health', '/api/health', '/status', '/api/status'];
      
      for (const endpoint of healthEndpoints) {
        try {
          const response = await this.client.get(endpoint);
          if (response.status === 200) {
            return {
              endpoint,
              status: 'healthy',
              data: response.data
            };
          }
        } catch (error) {
          // Continue to next endpoint
          continue;
        }
      }

      // If no health endpoint works, just return connection status
      const connectionOk = await this.testConnection();
      return {
        endpoint: 'rank-and-justify',
        status: connectionOk ? 'healthy' : 'unhealthy',
        data: { connection: connectionOk }
      };

    } catch (error) {
      logger.error('Failed to get AI node health info:', error);
      return null;
    }
  }

  /**
   * Convert jury configuration to AI node request format
   * @param {import('./types').JuryConfig} jury - Jury configuration
   * @returns {Array} Models in AI node format
   */
  convertJuryConfigToRequestFormat(jury) {
    return jury.models.map(model => ({
      provider: model.AI_PROVIDER,
      model: model.AI_MODEL,
      weight: model.WEIGHT,
      count: model.NO_COUNTS || 1
    }));
  }

  /**
   * Utility delay function
   * @param {number} ms - Milliseconds to wait
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = TestRunner; 