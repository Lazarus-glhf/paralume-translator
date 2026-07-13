import type { TranslationRequest, TranslationResult } from "../shared/types";

export interface TranslationProvider {
  readonly name: string;
  translate: (
    request: TranslationRequest,
  ) => Promise<readonly TranslationResult[]>;
}
