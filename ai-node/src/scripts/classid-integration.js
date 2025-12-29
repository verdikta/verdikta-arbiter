#!/usr/bin/env node

const { classMap } = require('@verdikta/common');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

class ClassIDIntegrator {
    constructor() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        this.modelsConfigPath = path.join(__dirname, '../config/models.ts');
        this.selectedClasses = [];
    }

    log(message, color = colors.reset) {
        console.log(`${color}${message}${colors.reset}`);
    }

    async question(prompt) {
        return new Promise((resolve) => {
            this.rl.question(prompt, resolve);
        });
    }

    displayHeader() {
        this.log('\n' + '='.repeat(60), colors.cyan);
        this.log('   Verdikta ClassID Model Pool Integration Tool', colors.bright + colors.cyan);
        this.log('='.repeat(60), colors.cyan);
        this.log('This tool will help you integrate ClassID Model Pools into your AI node.\n', colors.dim);
    }

    async listAvailableClasses() {
        this.log('📋 Available ClassID Model Pools:', colors.bright + colors.blue);
        this.log('-'.repeat(40), colors.dim);

        const allClasses = classMap.listClasses();
        
        if (allClasses.length === 0) {
            this.log('❌ No classes found in the ClassID mapping.', colors.red);
            return [];
        }

        allClasses.forEach((classItem, index) => {
            const cls = classMap.getClass(classItem.id);
            if (!cls) return;

            const statusIcon = cls.status === 'ACTIVE' ? '✅' : 
                              cls.status === 'EMPTY' ? '⚪' : 
                              cls.status === 'DEPRECATED' ? '⚠️' : '❓';

            this.log(`\n${index + 1}. ClassID ${cls.id}: ${cls.name}`, colors.bright);
            this.log(`   Status: ${statusIcon} ${cls.status}`, cls.status === 'ACTIVE' ? colors.green : colors.yellow);
            
            if (cls.models && cls.models.length > 0) {
                this.log(`   Models (${cls.models.length}):`, colors.dim);
                
                // Group models by provider
                const modelsByProvider = {};
                cls.models.forEach(model => {
                    if (!modelsByProvider[model.provider]) {
                        modelsByProvider[model.provider] = [];
                    }
                    modelsByProvider[model.provider].push(model.model);
                });

                Object.entries(modelsByProvider).forEach(([provider, models]) => {
                    this.log(`     ${provider}: ${models.join(', ')}`, colors.dim);
                });
            } else {
                this.log('   Models: None (Empty class)', colors.red);
            }

            if (cls.limits) {
                this.log(`   Limits: max_outcomes=${cls.limits.max_outcomes}, max_panel_size=${cls.limits.max_panel_size}`, colors.dim);
            }
        });

        return allClasses.filter(classItem => {
            const cls = classMap.getClass(classItem.id);
            return cls && cls.status === 'ACTIVE' && cls.models && cls.models.length > 0;
        });
    }

    async selectClasses(availableClasses) {
        this.log('\n🎯 Class Selection:', colors.bright + colors.magenta);
        this.log('-'.repeat(20), colors.dim);

        const answer = await this.question('\nWould you like to:\n1. Select specific classes\n2. Select all available classes\n\nEnter your choice (1 or 2): ');

        if (answer.trim() === '2') {
            this.selectedClasses = availableClasses;
            this.log(`✅ Selected all ${availableClasses.length} available classes.`, colors.green);
        } else if (answer.trim() === '1') {
            this.log('\nEnter the class numbers you want to support (comma-separated, e.g., 1,3,4):');
            const selection = await this.question('Classes: ');
            
            const indices = selection.split(',')
                .map(s => parseInt(s.trim()) - 1)
                .filter(i => i >= 0 && i < availableClasses.length);

            this.selectedClasses = indices.map(i => availableClasses[i]);
            
            if (this.selectedClasses.length > 0) {
                this.log(`✅ Selected ${this.selectedClasses.length} classes.`, colors.green);
                this.selectedClasses.forEach(classItem => {
                    const cls = classMap.getClass(classItem.id);
                    this.log(`   - ClassID ${cls.id}: ${cls.name}`, colors.dim);
                });
            } else {
                this.log('❌ No valid classes selected.', colors.red);
                return false;
            }
        } else {
            this.log('❌ Invalid selection.', colors.red);
            return false;
        }

        return true;
    }

    async readCurrentModelsConfig() {
        try {
            const content = fs.readFileSync(this.modelsConfigPath, 'utf8');
            
            // Parse the TypeScript config file dynamically for ALL providers
            const parseModels = (match) => {
                if (!match) return [];
                return match[1]
                    .split('\n')
                    .map(line => line.trim())
                    .filter(line => line.startsWith('{'))
                    .map(line => {
                        const nameMatch = line.match(/name:\s*['"`]([^'"`]+)['"`]/);
                        return nameMatch ? nameMatch[1] : null;
                    })
                    .filter(Boolean);
            };

            // Dynamically find all providers in the config
            const providers = {};
            const providerRegex = /(\w+):\s*\[([\s\S]*?)\]/g;
            let match;
            
            while ((match = providerRegex.exec(content)) !== null) {
                const providerName = match[1];
                const providerContent = match[2];
                providers[providerName] = parseModels([null, providerContent]);
            }

            return {
                ...providers,
                originalContent: content
            };
        } catch (error) {
            this.log(`❌ Error reading models config: ${error.message}`, colors.red);
            return null;
        }
    }

    async updateModelsConfig() {
        this.log('\n🔧 Updating models.ts configuration...', colors.bright + colors.blue);
        
        const currentConfig = await this.readCurrentModelsConfig();
        if (!currentConfig) return false;

        // Check if ClassID data includes capability information
        const sampleClass = classMap.getClass(128);
        const hasCapabilityData = sampleClass && sampleClass.models && 
                                 sampleClass.models.some(m => m.supported_file_types !== null);
        
        if (!hasCapabilityData) {
            this.log('⚠️  Note: ClassID data missing capability details (image support, file types)', colors.yellow);
            this.log('   Using heuristic detection for model capabilities', colors.dim);
        }

        // Collect all models from selected classes - DYNAMICALLY for ALL providers
        const newModels = {};
        const modelMetadata = {}; // Store metadata from ClassID for each model
        
        // Initialize with existing models from current config
        Object.keys(currentConfig).forEach(key => {
            if (key !== 'originalContent' && Array.isArray(currentConfig[key])) {
                newModels[key] = new Set(currentConfig[key]);
            }
        });

        // Add models from selected ClassIDs
        this.selectedClasses.forEach(classItem => {
            const cls = classMap.getClass(classItem.id);
            if (cls && cls.models) {
                cls.models.forEach(model => {
                    // Initialize provider set if it doesn't exist
                    if (!newModels[model.provider]) {
                        newModels[model.provider] = new Set();
                    }
                    // Add model to provider
                    newModels[model.provider].add(model.model);
                    
                    // Store metadata from ClassID data for capability detection
                    const modelKey = `${model.provider}:${model.model}`;
                    modelMetadata[modelKey] = {
                        supported_file_types: model.supported_file_types,
                        context_window_tokens: model.context_window_tokens
                    };
                });
            }
        });

        // Generate new config content
        const generateModelEntries = (models, provider) => {
            return Array.from(models).map(model => {
                // Get metadata from ClassID if available
                const modelKey = `${provider}:${model}`;
                const metadata = modelMetadata[modelKey];
                
                // Determine capabilities using ClassID data first, then heuristics
                const supportsImages = this.modelSupportsImages(model, provider, metadata);
                const supportsAttachments = this.modelSupportsAttachments(model, provider, metadata);
                
                return `    { name: '${model}', supportsImages: ${supportsImages}, supportsAttachments: ${supportsAttachments} },`;
            }).join('\n');
        };

        // Build config dynamically for all providers
        const providerConfigs = Object.keys(newModels)
            .sort() // Sort providers alphabetically for consistency
            .map(provider => {
                const modelEntries = generateModelEntries(newModels[provider], provider);
                return `  ${provider}: [\n${modelEntries}\n  ],`;
            })
            .join('\n');

        const newContent = `export const modelConfig = {\n${providerConfigs}\n};\n`;

        try {
            // Backup original file
            const backupPath = this.modelsConfigPath + '.backup';
            fs.copyFileSync(this.modelsConfigPath, backupPath);
            this.log(`📋 Backed up original config to: ${backupPath}`, colors.dim);

            // Write new config
            fs.writeFileSync(this.modelsConfigPath, newContent);
            this.log('✅ Updated models.ts configuration successfully!', colors.green);

            // Show what was added for each provider
            Object.keys(newModels).sort().forEach(provider => {
                const currentModels = currentConfig[provider] || [];
                const addedModels = Array.from(newModels[provider]).filter(m => !currentModels.includes(m));
                
                if (addedModels.length > 0) {
                    const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
                    this.log(`   Added ${providerName} models: ${addedModels.join(', ')}`, colors.green);
                }
            });

            return Array.from(newModels.ollama || []);
        } catch (error) {
            this.log(`❌ Error updating models config: ${error.message}`, colors.red);
            return false;
        }
    }

    modelSupportsImages(modelName, provider, metadata = null) {
        // Note: ClassID data doesn't currently include image MIME types explicitly
        // so we use heuristics for image support detection
        
        // Use heuristics based on known model capabilities
        if (provider === 'openai') {
            return modelName.includes('gpt-4') || 
                   modelName.includes('gpt-5') || 
                   modelName.includes('o3') || 
                   modelName === 'gpt-4o';
        } else if (provider === 'anthropic') {
            return modelName.includes('claude-3') || 
                   modelName.includes('claude-sonnet-4') ||
                   modelName.includes('claude-4');
        } else if (provider === 'ollama') {
            // For Ollama, check for vision-specific model names
            return modelName.includes('llava') || 
                   modelName.includes('vision') ||
                   modelName.includes('minicpm');
        } else if (provider === 'hyperbolic') {
            // Hyperbolic API models typically support images
            return true;
        } else if (provider === 'xai') {
            // Grok models support multimodal
            return true;
        }
        
        // For unknown providers: Default to TRUE for modern API-based models
        // This is a safer default as most modern LLM APIs support multimodal input
        // Models that don't support images will simply ignore image inputs gracefully
        return true;
    }

    modelSupportsAttachments(modelName, provider, metadata = null) {
        // Use ClassID data if available
        if (metadata && metadata.supported_file_types !== null) {
            // If supported_file_types is an array with items, attachments are supported
            return Array.isArray(metadata.supported_file_types) && 
                   metadata.supported_file_types.length > 0;
        }
        
        // Fall back to heuristics if ClassID data is null or missing
        if (provider === 'openai') {
            // OpenAI: All models except legacy 3.5-turbo support attachments
            return !modelName.includes('3.5-turbo') || 
                   modelName.includes('gpt-4') || 
                   modelName.includes('gpt-5') ||
                   modelName.includes('o3');
        } else if (provider === 'anthropic') {
            // Anthropic: Claude 3+ supports attachments
            return modelName.includes('claude-3') || 
                   modelName.includes('claude-sonnet-4') ||
                   modelName.includes('claude-4');
        } else if (provider === 'ollama') {
            // Ollama: Most models can handle text attachments
            return true;
        } else if (provider === 'hyperbolic') {
            // Hyperbolic API models support attachments
            return true;
        } else if (provider === 'xai') {
            // Grok models support attachments
            return true;
        }
        
        // For unknown providers: Default to TRUE for modern API-based models
        // This is a safe default as attachment handling is typically graceful
        // (models will extract text from attachments as needed)
        return true;
    }

    async pullOllamaModels(ollamaModels) {
        if (!ollamaModels || ollamaModels.length === 0) {
            return;
        }

        this.log('\n🐋 Pulling Ollama models...', colors.bright + colors.blue);
        
        for (const model of ollamaModels) {
            this.log(`\nPulling ${model}...`, colors.yellow);
            
            try {
                await this.runOllamaPull(model);
                this.log(`✅ Successfully pulled ${model}`, colors.green);
            } catch (error) {
                this.log(`❌ Failed to pull ${model}: ${error.message}`, colors.red);
                this.log('   You may need to pull this model manually: ollama pull ' + model, colors.dim);
            }
        }
    }

    runOllamaPull(model) {
        return new Promise((resolve, reject) => {
            const process = spawn('ollama', ['pull', model], {
                stdio: ['inherit', 'pipe', 'pipe']
            });

            let output = '';
            let error = '';

            process.stdout.on('data', (data) => {
                const text = data.toString();
                output += text;
                // Show progress
                process.stdout.write(text);
            });

            process.stderr.on('data', (data) => {
                error += data.toString();
            });

            process.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(error || `Process exited with code ${code}`));
                }
            });

            process.on('error', (err) => {
                if (err.code === 'ENOENT') {
                    reject(new Error('Ollama not found. Please install Ollama first.'));
                } else {
                    reject(err);
                }
            });
        });
    }

    async run() {
        try {
            this.displayHeader();

            const availableClasses = await this.listAvailableClasses();
            
            if (availableClasses.length === 0) {
                this.log('❌ No active classes with models found. Exiting.', colors.red);
                return;
            }

            const selectionSuccess = await this.selectClasses(availableClasses);
            if (!selectionSuccess) {
                this.log('❌ Class selection failed. Exiting.', colors.red);
                return;
            }

            const ollamaModels = await this.updateModelsConfig();
            if (ollamaModels === false) {
                this.log('❌ Failed to update models configuration. Exiting.', colors.red);
                return;
            }

            if (Array.isArray(ollamaModels) && ollamaModels.length > 0) {
                const pullOllama = await this.question('\nWould you like to pull the Ollama models now? (y/n): ');
                if (pullOllama.toLowerCase().startsWith('y')) {
                    await this.pullOllamaModels(ollamaModels);
                } else {
                    this.log('\n📝 To pull Ollama models later, run:', colors.dim);
                    ollamaModels.forEach(model => {
                        this.log(`   ollama pull ${model}`, colors.dim);
                    });
                }
            }

            this.log('\n🎉 ClassID integration completed successfully!', colors.bright + colors.green);
            this.log('\nNext steps:', colors.bright);
            this.log('1. Verify the updated models.ts configuration', colors.dim);
            this.log('2. Test your AI node with the new model pools', colors.dim);
            this.log('3. Update any hardcoded model references in your code', colors.dim);

        } catch (error) {
            this.log(`❌ An error occurred: ${error.message}`, colors.red);
            console.error(error);
        } finally {
            this.rl.close();
        }
    }
}

// Run the integrator if called directly
if (require.main === module) {
    const integrator = new ClassIDIntegrator();
    integrator.run().catch(console.error);
}

module.exports = ClassIDIntegrator;
