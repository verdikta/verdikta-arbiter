/**
 * Issue #13: arbiter-status.sh probed GET /health on the External Adapter, a
 * route that did not exist. These tests pin the route's existence and shape,
 * and assert that adding it did not change /version.
 */

const request = require('supertest');

// Keep the app's dependency graph quiet: the evaluate handler pulls in the AI
// client, which would otherwise try to reach configured providers.
jest.mock('../../services/aiClient');

const app = require('../../app');

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('verdikta-external-adapter');
  });

  it('reports a numeric uptime', async () => {
    const res = await request(app).get('/health');

    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('exposes the release stamp key (null when not stamped)', async () => {
    const res = await request(app).get('/health');

    expect(res.body).toHaveProperty('release');
  });
});

describe('GET /version (unchanged by #13)', () => {
  it('still returns the version payload', async () => {
    const res = await request(app).get('/version');

    expect(res.status).toBe(200);
    expect(res.body.service).toBe('verdikta-external-adapter');
    // Keys the ops tooling reads; values may legitimately be null in a
    // repository checkout that was never stamped by the installer.
    for (const key of ['adapter', 'aiNode', 'verdiktaCommon', 'release', 'uptimeSeconds']) {
      expect(res.body).toHaveProperty(key);
    }
  });
});

describe('unknown routes', () => {
  it('404s rather than being swallowed by the health route', async () => {
    const res = await request(app).get('/not-a-route');

    expect(res.status).toBe(404);
  });
});
