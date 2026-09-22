'use strict';

jest.mock('axios');
const axios = require('axios');
const { fetchJustificationJson } = require('../ipfs');

const GATEWAYS = ['https://gw-a.example', 'https://gw-b.example'];
const JUSTIFICATION = { scores: [{ outcome: 'A', score: 1000000 }], justification: 'ok', arbiter: { verdiktaCommon: '1.7.0' } };

describe('fetchJustificationJson', () => {
  beforeEach(() => axios.get.mockReset());

  it('returns the first gateway that serves a justification-shaped body', async () => {
    axios.get.mockRejectedValueOnce(new Error('timeout of 20000ms exceeded'));
    axios.get.mockResolvedValueOnce({ data: JSON.stringify(JUSTIFICATION) });
    const r = await fetchJustificationJson(GATEWAYS, 'QmX', 100);
    expect(r.json).toEqual(JUSTIFICATION);
    expect(r.gateway).toBe('https://gw-b.example');
    expect(r.attempt).toBe(1);
    expect(r.errors).toEqual(['https://gw-a.example: timeout of 20000ms exceeded']);
  });

  it('sweeps again after a delay when every gateway failed, and succeeds on a later attempt', async () => {
    axios.get
      .mockRejectedValueOnce(new Error('timeout'))          // attempt 1, gw-a
      .mockResolvedValueOnce({ data: '<html>403</html>' })   // attempt 1, gw-b (not JSON)
      .mockRejectedValueOnce(new Error('429'))              // attempt 2, gw-a
      .mockResolvedValueOnce({ data: JUSTIFICATION });      // attempt 2, gw-b
    const r = await fetchJustificationJson(GATEWAYS, 'QmX', 100, { attempts: 3, delayMs: 0 });
    expect(r.json).toEqual(JUSTIFICATION);
    expect(r.attempt).toBe(2);
    expect(axios.get).toHaveBeenCalledTimes(4);
  });

  it('gives up after the configured attempts with the last sweep\'s errors', async () => {
    axios.get.mockRejectedValue(new Error('Request failed with status code 429'));
    const r = await fetchJustificationJson(GATEWAYS, 'QmX', 100, { attempts: 3, delayMs: 0 });
    expect(r.json).toBeNull();
    expect(r.attempt).toBe(3);
    expect(axios.get).toHaveBeenCalledTimes(6);
    expect(r.errors).toHaveLength(2);
  });

  it('treats a missing or invalid retry config as a single attempt', async () => {
    axios.get.mockRejectedValue(new Error('down'));
    const r = await fetchJustificationJson(GATEWAYS, 'QmX', 100, { attempts: 'x', delayMs: -5 });
    expect(r.attempt).toBe(1);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});
