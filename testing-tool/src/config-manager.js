const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

/**
 * Configuration manager for the testing tool
 */
class ConfigManager {
  constructor() {
    this.configDir = path.join(__dirname, '../config');
    this.juriesDir = path.join(this.configDir, 'juries');
    this.toolConfigPath = path.join(this.configDir, 'tool-config.json');
  }

  /**
   * Initialize configuration directories and default files
   */
  async initialize() {
    try {
      // Ensure directories exist
      await fs.ensureDir(this.configDir);
      await fs.ensureDir(this.juriesDir);

      // Create default tool config if it doesn't exist
      if (!await fs.pathExists(this.toolConfigPath)) {
        await this.createDefaultToolConfig();
      }

      // Create example jury configs if none exist
      const juries = await this.getAllJuries();
      if (juries.length === 0) {
        await this.createExampleJuries();
      }

      logger.info('Configuration manager initialized');
    } catch (error) {
      logger.error('Failed to initialize configuration manager:', error);
      throw error;
    }
  }

  /**
   * Load tool configuration
   * @returns {import('./types').ToolConfig}
   */
  async getToolConfig() {
    try {
      const config = await fs.readJson(this.toolConfigPath);
      return {
        aiNodeUrl: config.aiNodeUrl || 'http://localhost:3000',
        timeoutMs: config.timeoutMs || 60000,
        maxRetries: config.maxRetries || 3,
        logLevel: config.logLevel || 'info'
      };
    } catch (error) {
      logger.error('Failed to load tool configuration:', error);
      throw new Error('Failed to load tool configuration');
    }
  }

  /**
   * Get jury configuration by ID
   * @param {number} juryId 
   * @returns {import('./types').JuryConfig}
   */
  async getJuryConfig(juryId) {
    try {
      const juryPath = path.join(this.juriesDir, `${juryId}.json`);
      if (!await fs.pathExists(juryPath)) {
        throw new Error(`Jury configuration ${juryId} not found`);
      }
      
      const config = await fs.readJson(juryPath);
      logger.debug(`Loaded jury config ${juryId}: ${config.name}`);
      return config;
    } catch (error) {
      logger.error(`Failed to load jury configuration ${juryId}:`, error);
      throw error;
    }
  }

  /**
   * Get all available jury configurations
   * @returns {Array<import('./types').JuryConfig>}
   */
  async getAllJuries() {
    try {
      const files = await fs.readdir(this.juriesDir);
      const juryFiles = files.filter(file => file.endsWith('.json') && /^\d+\.json$/.test(file));
      
      const juries = [];
      for (const file of juryFiles) {
        const juryId = parseInt(path.basename(file, '.json'));
        const jury = await this.getJuryConfig(juryId);
        juries.push(jury);
      }
      
      return juries.sort((a, b) => a.id - b.id);
    } catch (error) {
      logger.error('Failed to load jury configurations:', error);
      throw error;
    }
  }

  /**
   * Validate jury configuration
   * @param {import('./types').JuryConfig} jury 
   */
  validateJuryConfig(jury) {
    if (!jury.id || typeof jury.id !== 'number') {
      throw new Error('Jury must have a numeric ID');
    }
    
    if (!jury.name || typeof jury.name !== 'string') {
      throw new Error('Jury must have a name');
    }
    
    if (!Array.isArray(jury.models) || jury.models.length === 0) {
      throw new Error('Jury must have at least one model');
    }
    
    // Validate each model
    jury.models.forEach((model, index) => {
      if (!model.AI_PROVIDER || !model.AI_MODEL) {
        throw new Error(`Model ${index} must have AI_PROVIDER and AI_MODEL`);
      }
      
      if (typeof model.WEIGHT !== 'number' || model.WEIGHT < 0 || model.WEIGHT > 1) {
        throw new Error(`Model ${index} must have WEIGHT between 0 and 1`);
      }
    });
    
    // Check that weights sum to approximately 1
    const totalWeight = jury.models.reduce((sum, model) => sum + model.WEIGHT, 0);
    if (Math.abs(totalWeight - 1.0) > 0.01) {
      throw new Error(`Total model weights must sum to 1.0, got ${totalWeight}`);
    }
  }

  /**
   * Create default tool configuration
   */
  async createDefaultToolConfig() {
    const defaultConfig = {
      aiNodeUrl: 'http://localhost:3000',
      timeoutMs: 60000,
      maxRetries: 3,
      logLevel: 'info'
    };
    
    await fs.writeJson(this.toolConfigPath, defaultConfig, { spaces: 2 });
    logger.info('Created default tool configuration');
  }

  /**
   * Create example jury configurations
   */
  async createExampleJuries() {
    const exampleJuries = [
      {
        id: 1,
        name: "Conservative Financial Panel",
        models: [
          {
            AI_PROVIDER: "OpenAI",
            AI_MODEL: "gpt-4",
            WEIGHT: 0.5,
            NO_COUNTS: 1
          },
          {
            AI_PROVIDER: "Anthropic", 
            AI_MODEL: "claude-3-sonnet-20240229",
            WEIGHT: 0.5,
            NO_COUNTS: 1
          }
        ],
        iterations: 1
      },
      {
        id: 2,
        name: "Tech Innovation Panel",
        models: [
          {
            AI_PROVIDER: "OpenAI",
            AI_MODEL: "gpt-4o",
            WEIGHT: 0.4,
            NO_COUNTS: 1
          },
          {
            AI_PROVIDER: "Anthropic",
            AI_MODEL: "claude-3-sonnet-20240229", 
            WEIGHT: 0.4,
            NO_COUNTS: 1
          },
          {
            AI_PROVIDER: "Ollama",
            AI_MODEL: "phi3",
            WEIGHT: 0.2,
            NO_COUNTS: 1
          }
        ],
        iterations: 2
      },
      {
        id: 3,
        name: "Single OpenAI GPT-4",
        models: [
          {
            AI_PROVIDER: "OpenAI",
            AI_MODEL: "gpt-4",
            WEIGHT: 1.0,
            NO_COUNTS: 1
          }
        ],
        iterations: 1
      }
    ];

    for (const jury of exampleJuries) {
      const juryPath = path.join(this.juriesDir, `${jury.id}.json`);
      await fs.writeJson(juryPath, jury, { spaces: 2 });
      logger.info(`Created example jury configuration: ${jury.name}`);
    }
  }
}

module.exports = new ConfigManager(); 