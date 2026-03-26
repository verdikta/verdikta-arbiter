import { NextResponse } from 'next/server';
import { resolveProviderConfig } from '../../../lib/llm/provider-config';

function buildGatewayStatus() {
  const classes = ['openai', 'anthropic', 'xai', 'hyperbolic', 'ollama'];

  const routing = classes.map((providerClass) => {
    const resolution = resolveProviderConfig(providerClass);
    return {
      class: providerClass,
      backend: resolution.backend,
      model: resolution.modelOverride || null,
      reason: resolution.reason,
    };
  });

  return {
    mode: process.env.AI_GATEWAY || 'openrouter',
    openrouterConfigured: !!process.env.OPENROUTER_API_KEY,
    routing,
  };
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'ai-evaluation-service',
    version: process.env.npm_package_version || '1.0.0',
    endpoints: {
      'rank-and-justify': '/api/rank-and-justify',
    },
    ai_gateway: buildGatewayStatus(),
  });
}
