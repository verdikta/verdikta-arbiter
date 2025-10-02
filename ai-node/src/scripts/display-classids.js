#!/usr/bin/env node

/**
 * ClassID Information Display Utility
 * Shows available ClassID model pools to help users make informed decisions
 * about which API keys they need and which models will be available.
 */

// Load @verdikta/common directly (same approach as working integration script)
const { classMap } = require('@verdikta/common');

// Model descriptions and justification recommendations (only one per ClassID)
const modelDescriptions = {
    // OpenAI models
    'gpt-5-2025-08-07': 'Highest quality, most capable',
    'gpt-5-mini-2025-08-07': 'Balanced performance and cost',
    'gpt-5-nano-2025-08-07': 'Fast and efficient - ⭐ Recommended for justification',
    
    // Anthropic models
    'claude-sonnet-4-20250514': 'Excellent reasoning capabilities',
    'claude-3-7-sonnet-20250219': 'Strong performance and reliability',
    'claude-3-5-haiku-20241022': 'Fast and economical option',
    
    // Ollama models
    'llama3.1:8b': 'Reliable, well-tested model',
    'llava:7b': 'Vision-capable model for images',
    'deepseek-r1:8b': 'Good reasoning capabilities',
    'qwen3:8b': 'Efficient Chinese-English model',
    'gemma3n:e4b': 'Efficient and capable - ⭐ Recommended for justification'
};

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

function log(message, color = colors.reset) {
    console.log(`${color}${message}${colors.reset}`);
}

function displayClassIDInfo() {
    log('\n' + '='.repeat(70), colors.cyan);
    log('   Verdikta ClassID Model Pools - Available Classes', colors.bright + colors.cyan);
    log('='.repeat(70), colors.cyan);
    log('Each ClassID represents a different model pool for AI evaluation.', colors.dim);
    log('Choose classes based on your preferred models and available API keys.\n', colors.dim);
    

    try {
        const allClasses = classMap.listClasses();
        
        if (allClasses.length === 0) {
            log('❌ No classes found in the ClassID mapping.', colors.red);
            return { hasActiveClasses: false, providers: new Set() };
        }

        const activeClasses = [];
        const allProviders = new Set();
        const providersByClass = {};

        // Filter and analyze classes - show ACTIVE classes and EMPTY classes for transparency
        allClasses.forEach(classItem => {
            const cls = classMap.getClass(classItem.id);
            if (!cls || (cls.status !== 'ACTIVE' && cls.status !== 'EMPTY')) {
                return;
            }

            activeClasses.push(cls);
            const classProviders = new Set();

            if (cls.models && cls.models.length > 0) {
                cls.models.forEach(model => {
                    allProviders.add(model.provider);
                    classProviders.add(model.provider);
                });
            }

            providersByClass[cls.id] = classProviders;
        });

        if (activeClasses.length === 0) {
            log('❌ No active classes with models found.', colors.red);
            return { hasActiveClasses: false, providers: new Set() };
        }

        // Display each class with enhanced model information
        activeClasses.forEach((cls, index) => {
            const statusIcon = cls.status === 'ACTIVE' ? '✅' : 
                              cls.status === 'EMPTY' ? '⚪' : 
                              cls.status === 'DEPRECATED' ? '⚠️' : '❓';
            const statusColor = cls.status === 'ACTIVE' ? colors.green :
                               cls.status === 'EMPTY' ? colors.yellow :
                               colors.red;
            
            log(`${index + 1}. ClassID ${cls.id}: ${cls.name}`, colors.bright + colors.blue);
            log(`   Status: ${statusIcon} ${cls.status}`, statusColor);
            
            if (cls.models && cls.models.length > 0) {
                log(`   Available Models (${cls.models.length} total):`, colors.bright);
                
                // Group models by provider with enhanced display
                const modelsByProvider = {};
                cls.models.forEach(model => {
                    if (!modelsByProvider[model.provider]) {
                        modelsByProvider[model.provider] = [];
                    }
                    modelsByProvider[model.provider].push({
                        name: model.model,
                        capabilities: model.supported_file_types || [],
                        supportsImages: model.supports_images || false
                    });
                });

                Object.entries(modelsByProvider).forEach(([provider, models]) => {
                    const providerColor = provider === 'openai' ? colors.green :
                                        provider === 'anthropic' ? colors.magenta :
                                        provider === 'ollama' ? colors.yellow :
                                        provider === 'hyperbolic' ? colors.cyan :
                                        colors.reset;
                    
                    log(`     ${provider.toUpperCase()} (${models.length} models):`, providerColor);
                    
                    // Show individual models with capabilities and descriptions
                    models.forEach(model => {
                        let capabilities = [];
                        if (model.supportsImages) capabilities.push('images');
                        if (model.capabilities && model.capabilities.length > 0) {
                            // Add capabilities that aren't already included
                            model.capabilities.forEach(cap => {
                                if (!capabilities.includes(cap)) {
                                    capabilities.push(cap);
                                }
                            });
                        }
                        
                        const capabilityText = capabilities.length > 0 ? 
                            ` [${capabilities.join(', ')}]` : '';
                        
                        // Get model description and check if it's recommended for justification
                        const description = modelDescriptions[model.name];
                        const isJustificationRecommended = description && description.includes('⭐ Recommended for justification');
                        const descriptionText = description ? ` - ${description}` : '';
                        
                        const modelColor = isJustificationRecommended ? colors.bright : colors.dim;
                        
                        log(`       • ${model.name}${capabilityText}${descriptionText}`, modelColor);
                    });
                });
                
                // Show API requirements for this specific class
                const requiredProviders = Object.keys(modelsByProvider).filter(p => p !== 'ollama');
                if (requiredProviders.length > 0) {
                    const keyNames = requiredProviders.map(p => 
                        p === 'openai' ? 'OpenAI API Key' :
                        p === 'anthropic' ? 'Anthropic API Key' :
                        `${p.toUpperCase()} API Key`
                    );
                    log(`   Required API Keys: ${keyNames.join(', ')}`, colors.yellow);
                } else {
                    log(`   Required API Keys: None (Ollama models only)`, colors.green);
                }
            } else {
                log(`   Models: None (Empty class)`, colors.red);
                
                // Show special note for ClassID 130 about Hyperbolic API
                if (cls.id === 130) {
                    log(`   Note: Will require Hyperbolic API key when active (not Ollama)`, colors.yellow);
                }
            }

            if (cls.limits) {
                log(`   Limits: max_outcomes=${cls.limits.max_outcomes}, max_panel_size=${cls.limits.max_panel_size}`, colors.dim);
            }
            
            log(''); // Empty line between classes
        });

        // Display API key recommendations
        log('📋 API Key Requirements by ClassID:', colors.bright + colors.yellow);
        log('-'.repeat(40), colors.dim);
        
        activeClasses.forEach(cls => {
            const providers = Array.from(providersByClass[cls.id]);
            
            // Special handling for ClassID 130 (Hyperbolic)
            if (cls.id === 130) {
                if (cls.status === 'EMPTY') {
                    log(`ClassID ${cls.id} (${cls.name}): Will require Hyperbolic API Key when active`, colors.yellow);
                } else {
                    log(`ClassID ${cls.id} (${cls.name}): Requires Hyperbolic API Key`, colors.yellow);
                }
                return;
            }
            
            const apiKeys = providers.filter(p => p !== 'ollama').map(p => 
                p === 'openai' ? 'OpenAI API Key' :
                p === 'anthropic' ? 'Anthropic API Key' :
                `${p} API Key`
            );
            
            if (apiKeys.length === 0) {
                log(`ClassID ${cls.id} (${cls.name}): No API keys required (Ollama only)`, colors.green);
            } else {
                log(`ClassID ${cls.id} (${cls.name}): Requires ${apiKeys.join(', ')}`, colors.yellow);
            }
        });

        log('\n💡 Recommendations:', colors.bright + colors.cyan);
        log('-'.repeat(20), colors.dim);
        log('• For open source only: Use ClassID 129 (no API keys needed)', colors.green);
        log('• For commercial models: Use ClassID 128 (requires OpenAI + Anthropic keys)', colors.yellow);
        log('• For Hyperbolic API: Use ClassID 130 (requires Hyperbolic API key)', colors.cyan);
        log('• For mixed usage: Multiple ClassIDs (requires respective API keys)', colors.blue);
        log('• Leave API keys blank if you don\'t plan to use those providers\n', colors.dim);

        return { 
            hasActiveClasses: true, 
            providers: allProviders,
            activeClasses: activeClasses,
            providersByClass: providersByClass
        };

    } catch (error) {
        log(`❌ Error accessing ClassID data: ${error.message}`, colors.red);
        log('Make sure @verdikta/common is properly installed.', colors.dim);
        return { hasActiveClasses: false, providers: new Set() };
    }
}

function getJustificationModels() {
    log('\n🎯 Available Models for Justification Generation:', colors.bright + colors.magenta);
    log('-'.repeat(50), colors.dim);
    
    const justificationModels = [
        { provider: 'openai', model: 'gpt-5-nano-2025-08-07', description: 'OpenAI GPT-5 Nano (recommended default, fast and efficient)' },
        { provider: 'openai', model: 'gpt-5-mini-2025-08-07', description: 'OpenAI GPT-5 Mini (balanced performance and cost)' },
        { provider: 'openai', model: 'gpt-5-2025-08-07', description: 'OpenAI GPT-5 (highest quality, most capable)' },
        { provider: 'anthropic', model: 'claude-sonnet-4-20250514', description: 'Anthropic Claude Sonnet 4 (excellent reasoning)' },
        { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219', description: 'Anthropic Claude 3.7 Sonnet (strong performance)' },
        { provider: 'anthropic', model: 'claude-3-5-haiku-20241022', description: 'Anthropic Claude 3.5 Haiku (fast and economical)' },
        { provider: 'ollama', model: 'gemma3n:e4b', description: 'Ollama Gemma 3N (recommended for OSS, efficient)' },
        { provider: 'ollama', model: 'deepseek-r1:8b', description: 'Ollama DeepSeek R1 (good reasoning, free)' },
        { provider: 'ollama', model: 'llama3.1:8b', description: 'Ollama Llama 3.1 8B (reliable, free)' }
    ];

    justificationModels.forEach((model, index) => {
        const providerColor = model.provider === 'openai' ? colors.green :
                            model.provider === 'anthropic' ? colors.magenta :
                            colors.yellow;
        log(`${index + 1}. ${model.provider.toUpperCase()}: ${model.model}`, providerColor);
        log(`   ${model.description}`, colors.dim);
    });

    return justificationModels;
}

// Export functions for use in other scripts
module.exports = {
    displayClassIDInfo,
    getJustificationModels,
    colors,
    log
};

// Run directly if called as script
if (require.main === module) {
    const result = displayClassIDInfo();
    // Justification model recommendations are now shown inline with each ClassID
}
