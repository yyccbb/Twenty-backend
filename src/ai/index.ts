import type { Config } from '../config.js';
import { FakeAiProvider } from './fake.js';
import type { AiProvider } from './provider.js';
import { SiliconFlowProvider } from './siliconflow.js';

export type { AiProvider } from './provider.js';
export { AiOutputError, BREAKDOWN_PROMPT_VERSION, generateBreakdown } from './breakdown.js';

export function createAiProvider(config: Config): AiProvider {
  switch (config.AI_PROVIDER) {
    case 'siliconflow':
      return new SiliconFlowProvider(
        { apiKey: config.SILICONFLOW_API_KEY!, baseURL: config.SILICONFLOW_BASE_URL, timeoutMs: config.AI_TIMEOUT_MS },
        config.SILICONFLOW_MODEL!,
      );
    case 'fake':
      return new FakeAiProvider();
  }
}
