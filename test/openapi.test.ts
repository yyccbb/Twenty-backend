import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderOpenApiYaml } from '../src/openapi.js';

describe('contracts/openapi.yaml', () => {
  it('matches the route schemas (run `npm run openapi` after changing a route)', () => {
    const committed = readFileSync(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8');
    expect(committed).toBe(renderOpenApiYaml());
  });
});
