// The only AI surface the rest of the backend may use. Provider-specific code stays in src/ai/.

export interface AiMessage {
  role: 'system' | 'user';
  content: string;
}

export interface AiJsonCompletion {
  /** The raw model output; callers validate it. */
  content: string;
  model: string;
  tokensUsed: number | null;
}

export interface AiProvider {
  readonly name: string;
  /** Asks the model for a single JSON object. */
  completeJson(messages: AiMessage[], options?: { signal?: AbortSignal }): Promise<AiJsonCompletion>;
}
