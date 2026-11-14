/**
 * The testing tool's table of OpenRouter ids (testing-tool/src/openrouter-routes.json, node A19) is the AI Node's own
 * mapping. A real-jury run's meter prices a call by the id it carries, and the batch reads each juror's answers by its
 * panel id or this one, so an id the AI Node sends that the table does not have would be refused or lost.
 */
import fs from 'fs';
import path from 'path';
import { codeReview } from '@verdikta/common';
import { getOpenRouterModelPrefix, resolveOpenRouterModelId, ProviderClass } from '../../../config/openrouter-models';

const TABLE = path.join(__dirname, '..', '..', '..', '..', '..', 'testing-tool', 'src', 'openrouter-routes.json');
const routes: Record<string, Record<string, string>> = JSON.parse(fs.readFileSync(TABLE, 'utf8'));

describe('the testing tool\'s OpenRouter ids (A19)', () => {
  test('each is what the AI Node sends for that model when the gateway routes it through OpenRouter', () => {
    for (const [providerClass, models] of Object.entries(routes)) {
      if (providerClass === 'comment') continue;
      const prefix = getOpenRouterModelPrefix(providerClass as ProviderClass);
      expect(prefix).toBeTruthy();
      for (const [model, id] of Object.entries(models)) {
        expect(`${providerClass} ${model} ${resolveOpenRouterModelId(prefix as string, model)}`).toBe(`${providerClass} ${model} ${id}`);
      }
    }
  });

  test('every code-class pool model outside the openrouter provider has its id there', () => {
    for (const codeClass of Object.values(codeReview.CODE_CLASSES)) {
      for (const { provider, model } of codeClass.models) {
        if (provider === 'openrouter') continue;
        expect(`${provider} ${model} ${typeof (routes[provider] || {})[model]}`).toBe(`${provider} ${model} string`);
      }
    }
  });
});
