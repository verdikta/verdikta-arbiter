const { summarizeAttachment, summarizePayload } = require('../../utils/payloadSummary');

describe('summarizeAttachment', () => {
  test('reads the media type from a data URI header', () => {
    const uri = `data:image/png;base64,${'A'.repeat(5000)}`;
    expect(summarizeAttachment(uri)).toEqual({ mediaType: 'image/png', length: uri.length });
    expect(summarizeAttachment('data:text/csv;charset=utf-8;base64,QQ==').mediaType).toBe('text/csv');
  });

  test('a data URI without a header comma is unknown', () => {
    expect(summarizeAttachment(`data:${'x'.repeat(1000)}`).mediaType).toBe('unknown');
    expect(summarizeAttachment('data:;base64,QQ==').mediaType).toBe('unknown');
  });

  test('a raw string is a text attachment', () => {
    expect(summarizeAttachment('some notes', 'notes.txt')).toEqual({ name: 'notes.txt', mediaType: 'text/plain', length: 10 });
  });

  test('a non-string attachment is unknown and not inspected', () => {
    expect(summarizeAttachment({ type: 'image', data: 'QUJD' })).toEqual({ mediaType: 'unknown' });
  });
});

describe('summarizePayload', () => {
  test('pairs attachments with attachmentNames by index and omits contents', () => {
    const image = `data:image/jpeg;base64,${'/9j/'.repeat(2000)}`;
    const summary = summarizePayload({
      prompt: 'Judge it',
      models: [{ provider: 'Anthropic', model: 'claude-sonnet-5', weight: 1, count: 2, extra: 'dropped' }],
      iterations: 1,
      outcomes: ['A', 'B'],
      attachments: [image, 'notes body'],
      attachmentNames: ['submission/photo.jpg'],
    });

    expect(summary).toEqual({
      promptLength: 8,
      models: [{ provider: 'Anthropic', model: 'claude-sonnet-5', weight: 1, count: 2 }],
      iterations: 1,
      outcomes: ['A', 'B'],
      attachmentsCount: 2,
      attachments: [
        { name: 'submission/photo.jpg', mediaType: 'image/jpeg', length: image.length },
        { mediaType: 'text/plain', length: 10 },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('/9j/');
    expect(JSON.stringify(summary)).not.toContain('notes body');
  });

  test('tolerates a payload without models or attachments', () => {
    expect(summarizePayload({ prompt: 'p' })).toMatchObject({ promptLength: 1, models: [], outcomes: [], attachmentsCount: 0, attachments: [] });
  });
});
