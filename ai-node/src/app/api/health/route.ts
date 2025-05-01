import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'ai-evaluation-service',
    version: process.env.npm_package_version || '1.0.0',
    endpoints: {
      'rank-and-justify': '/api/rank-and-justify'
    }
  });
}