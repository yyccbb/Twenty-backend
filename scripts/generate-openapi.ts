import { writeFileSync } from 'node:fs';
import { renderOpenApiYaml } from '../src/openapi.js';

writeFileSync(new URL('../contracts/openapi.yaml', import.meta.url), renderOpenApiYaml());
console.log('wrote contracts/openapi.yaml');
