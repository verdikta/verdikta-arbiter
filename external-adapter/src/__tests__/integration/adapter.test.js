const request = require('supertest');
const express = require('express');
const bodyParser = require('body-parser');

// Mock dependencies
jest.mock('../../services/aiClient');

const aiClient = require('../../services/aiClient');

// Create express app for testing
const app = express();
app.use(bodyParser.json());
const evaluateHandler = require('../../handlers/evaluateHandler');

app.post('/evaluate', async (req, res) => {
  try {
    const result = await evaluateHandler(req.body);
    res.status(result.statusCode).json(result);
  } catch (error) {
    const errorResponse = {
      jobRunID: req.body?.id || 'unknown',
      status: 'errored',
      statusCode: 500,
      error: error.message || 'Unknown error'
    };
    res.status(500).json(errorResponse);
  }
});

describe('Adapter Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock successful AI evaluation
    aiClient.evaluate.mockResolvedValue({
      scores: [{ outcome: 'default', score: 0.8 }],
      justification: 'Test justification'
    });
  });

  it('should handle a valid evaluation request', async () => {
    const response = await request(app)
      .post('/evaluate')
      .send({
        id: '1',
        data: {
          cid: 'QmcMjSr4pL8dpNzjhGWaZ6vRmvv7fN3xsLJCDpqVsH7gv7'
        }
      });

    expect(response.status).toBe(200);
    // Only check the structure and types, not the exact CID value
    expect(response.body).toMatchObject({
      jobRunID: '1',
      statusCode: 200,
      status: 'success',
      data: {
        aggregatedScore: [0.8],
        justificationCID: expect.any(String)
      }
    });

    // Verify the CID format if needed
    expect(response.body.data.justificationCID).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
  });

  it('should handle invalid requests', async () => {
    const response = await request(app)
      .post('/evaluate')
      .send({
        id: '1',
        data: {} // Missing required cid
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      jobRunID: '1',
      status: 'errored',
      statusCode: 500,
      error: 'Invalid request: "data.cid" is required',
      data: {
        aggregatedScore: [0],
        error: 'Invalid request: "data.cid" is required',
        justification: ''
      }
    });
  });

  it('should handle IPFS errors', async () => {
    const response = await request(app)
      .post('/evaluate')
      .send({
        id: '1',
        data: {
          cid: 'invalid-cid'
        }
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      jobRunID: '1',
      status: 'errored',
      statusCode: 500,
      error: 'Invalid request: must be a valid IPFS CID format',
      data: {
        aggregatedScore: [0],
        error: 'Invalid request: must be a valid IPFS CID format',
        justification: ''
      }
    });
  });
}); 