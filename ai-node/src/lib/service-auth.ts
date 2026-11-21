import { createHash, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';

/** Call inside each protected handler, before reading bodies or using providers.
 * This does not rely on Next middleware or a caller's forwarding/IP headers.
 */
export function requireServiceAuth(request: Request): NextResponse | null {
  const token = process.env.AI_NODE_API_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    return NextResponse.json({ error: 'Service authentication is not configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const authorization = request?.headers?.get('authorization');
  const match = authorization && /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(authorization);
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!match || !timingSafeEqual(digest(match[1]), digest(token))) {
    return NextResponse.json({ error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' } });
  }
  return null;
}
