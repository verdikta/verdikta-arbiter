#!/usr/bin/env node

// Test script to verify ClassID integration functionality
const { classMap } = require('@verdikta/common');

console.log('🧪 Testing ClassID Integration...\n');

// Test 1: Check if classMap is available
try {
    const classes = classMap.listClasses();
    console.log('✅ ClassMap loaded successfully');
    console.log(`   Found ${classes.length} classes: [${classes.map(c => c.id).join(', ')}]`);
} catch (error) {
    console.error('❌ Failed to load ClassMap:', error.message);
    process.exit(1);
}

// Test 2: Check specific classes
const testClasses = [128, 129, 130];
testClasses.forEach(classId => {
    const cls = classMap.getClass(classId);
    if (cls) {
        console.log(`✅ ClassID ${classId}: ${cls.name} (${cls.status})`);
        if (cls.models && cls.models.length > 0) {
            console.log(`   Models: ${cls.models.map(m => `${m.provider}/${m.model}`).join(', ')}`);
        } else {
            console.log('   No models available');
        }
    } else {
        console.log(`❌ ClassID ${classId}: Not found`);
    }
});

// Test 3: Validation test
console.log('\n🔍 Testing validation functionality...');
const sampleManifest = {
    outcomes: Array.from({length: 25}, (_, i) => `outcome-${i}`), // More than limit
    panel: [
        { provider: 'openai', model: 'gpt-4' },
        { provider: 'anthropic', model: 'claude-3-sonnet' }
    ]
};

try {
    const result = classMap.validateQueryAgainstClass(sampleManifest, 128);
    if (result.ok) {
        console.log('✅ Validation passed');
        console.log(`   Issues found: ${result.issues.length}`);
        result.issues.forEach(issue => {
            console.log(`   - ${issue.code}: ${issue.detail}`);
        });
    } else {
        console.log('❌ Validation failed');
        console.log(`   Reason: ${result.issues[0]?.detail || 'Unknown'}`);
    }
} catch (error) {
    console.log('❌ Validation test failed:', error.message);
}

// Test 4: Check current models.ts
console.log('\n📋 Current models.ts configuration:');
try {
    const fs = require('fs');
    const path = require('path');
    const modelsPath = path.join(__dirname, '../config/models.ts');
    const content = fs.readFileSync(modelsPath, 'utf8');
    
    // Count models by provider
    const openaiCount = (content.match(/openai:[\s\S]*?\[[\s\S]*?\]/)?.[0].match(/name:/g) || []).length;
    const anthropicCount = (content.match(/anthropic:[\s\S]*?\[[\s\S]*?\]/)?.[0].match(/name:/g) || []).length;
    const ollamaCount = (content.match(/ollama:[\s\S]*?\[[\s\S]*?\]/)?.[0].match(/name:/g) || []).length;
    
    console.log(`   OpenAI models: ${openaiCount}`);
    console.log(`   Anthropic models: ${anthropicCount}`);
    console.log(`   Ollama models: ${ollamaCount}`);
    
} catch (error) {
    console.log('❌ Could not read models.ts:', error.message);
}

// Test 5: Check model capability detection
console.log('\n🔍 Testing model capability detection:');
const testModels = [
    { provider: 'openai', model: 'gpt-5' },
    { provider: 'openai', model: 'gpt-5-mini' },
    { provider: 'anthropic', model: 'claude-sonnet-4' },
    { provider: 'ollama', model: 'llava:7b' }
];

// Import the ClassIDIntegrator to test capability detection
const ClassIDIntegrator = require('./classid-integration.js');
const integrator = new ClassIDIntegrator();

testModels.forEach(model => {
    const supportsImages = integrator.modelSupportsImages(model.model, model.provider);
    const supportsAttachments = integrator.modelSupportsAttachments(model.model, model.provider);
    console.log(`   ${model.provider}/${model.model}: images=${supportsImages}, attachments=${supportsAttachments}`);
});

console.log('\n🎉 ClassID integration test completed!');
console.log('\nTo run the full integration:');
console.log('   npm run integrate-classid');
