import type { ContextFormed } from '@deepseek-ai/dsh-llm/message';
import type { JsonRecord } from '../ports/contracts.js';

/** The official message-source registry is merge-extensible per producer. */
export type NexusMessageSource = {
  readonly kind: 'plugin:@local/dsh-nexus';
  readonly meta?: Readonly<JsonRecord>;
} & ContextFormed;

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    'plugin:@local/dsh-nexus': NexusMessageSource;
  }
}

export const NEXUS_SOURCE = 'plugin:@local/dsh-nexus' as const;
