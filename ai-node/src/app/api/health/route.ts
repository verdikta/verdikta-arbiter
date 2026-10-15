import { NextResponse } from 'next/server';
import { resolveProviderConfig } from '../../../lib/llm/provider-config';

// A GET handler that never reads the request is prerendered by `next build`:
// the timestamp and the gateway routing (read from env, checked by the
// doctor) would be frozen at build time. Answer every request live.
export const dynamic = 'force-dynamic';

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
