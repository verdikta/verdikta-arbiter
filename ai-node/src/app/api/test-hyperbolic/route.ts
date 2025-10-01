import { NextResponse } from 'next/server';
import { HyperbolicProvider } from '../../../lib/llm/hyperbolic-provider';

/**
 * Test endpoint for Hyperbolic provider
 * 
 * GET /api/test-hyperbolic
 * 
 * Tests the Hyperbolic provider initialization and basic functionality
 */
export async function GET() {
  const results: any = {
    timestamp: new Date().toISOString(),
    provider: 'Hyperbolic',
    tests: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
    }
  };

  try {
    // Test 1: Provider Initialization
    console.log('🧪 Test 1: Provider Initialization');
    let provider: HyperbolicProvider;
    
    try {
      provider = new HyperbolicProvider();
      await provider.initialize();
      
      results.tests.push({
        name: 'Provider Initialization',
        status: 'PASSED',
        message: 'Provider initialized successfully'
      });
      results.summary.passed++;
    } catch (error: any) {
      results.tests.push({
        name: 'Provider Initialization',
        status: 'FAILED',
        error: error.message
      });
      results.summary.failed++;
      results.summary.total++;
      
      return NextResponse.json(results, { status: 500 });
    }

    // Test 2: Get Available Models
    console.log('🧪 Test 2: Get Available Models');
    try {
      const models = await provider.getModels();
      
      results.tests.push({
        name: 'Get Available Models',
        status: 'PASSED',
        message: `Found ${models.length} models`,
        data: models.map(m => ({
          name: m.name,
          supportsImages: m.supportsImages,
          supportsAttachments: m.supportsAttachments
        }))
      });
      results.summary.passed++;
    } catch (error: any) {
      results.tests.push({
        name: 'Get Available Models',
        status: 'FAILED',
        error: error.message
      });
      results.summary.failed++;
    }

    // Test 3: Simple Text Generation (each model)
    const models = await provider.getModels();
    
    for (const modelInfo of models) {
      console.log(`🧪 Test: Text Generation - ${modelInfo.name}`);
      
      try {
        const prompt = 'What is 2+2? Answer in one short sentence.';
        const startTime = Date.now();
        
        const response = await provider.generateResponse(prompt, modelInfo.name);
        
        const duration = Date.now() - startTime;
        
        results.tests.push({
          name: `Text Generation - ${modelInfo.name}`,
          status: 'PASSED',
          message: 'Generated response successfully',
          data: {
            prompt,
            response: response.substring(0, 200) + (response.length > 200 ? '...' : ''),
            responseLength: response.length,
            durationMs: duration
          }
        });
        results.summary.passed++;
      } catch (error: any) {
        results.tests.push({
          name: `Text Generation - ${modelInfo.name}`,
          status: 'FAILED',
          error: error.message,
          stack: error.stack
        });
        results.summary.failed++;
      }
    }

    // Calculate totals
    results.summary.total = results.summary.passed + results.summary.failed;

    // Return results
    return NextResponse.json(results, { 
      status: results.summary.failed > 0 ? 500 : 200 
    });

  } catch (error: any) {
    console.error('❌ Test suite error:', error);
    
    return NextResponse.json({
      error: 'Test suite failed',
      message: error.message,
      stack: error.stack
    }, { status: 500 });
  }
}

