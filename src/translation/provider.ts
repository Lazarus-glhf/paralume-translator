import type { TranslationRequest, TranslationResult } from "../shared/types";

export interface TranslationProviderContext {
  readonly signal?: AbortSignal;
}

export interface TranslationProvider {
  readonly name: string;
  translate: (
    request: TranslationRequest,
    context?: TranslationProviderContext,
  ) => Promise<readonly TranslationResult[]>;
}

export type TranslationProviderResolver = () => Promise<TranslationProvider>;
