import type { AiJsonCompletion, AiMessage, AiProvider } from './provider.js';

/** Deterministic provider for tests and local development without an API key. */
export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
  calls: AiMessage[][] = [];

  constructor(private readonly respond?: (messages: AiMessage[]) => string) {}

  async completeJson(messages: AiMessage[]): Promise<AiJsonCompletion> {
    this.calls.push(messages);
    const content =
      this.respond?.(messages) ??
      JSON.stringify({
        summary: 'A starter plan in 20-minute blocks.',
        items: [
          { title: 'Research the basics', description: 'Read an introductory guide.', duration_bars: 3, sessions_per_week: 2 },
          { title: 'Practice session', description: null, duration_bars: 2, sessions_per_week: 4 },
          { title: 'Weekly review', description: 'Look back at progress.', duration_bars: 1, sessions_per_week: 1 },
        ],
      });
    return { content, model: 'fake-model', tokensUsed: 0 };
  }
}
