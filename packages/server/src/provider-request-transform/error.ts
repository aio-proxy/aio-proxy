export type ProviderRequestTransformErrorCode =
  | 'REQUEST_TRANSFORM_BODY_NOT_JSON'
  | 'REQUEST_TRANSFORM_BODY_PARSE_FAILED'
  | 'REQUEST_TRANSFORM_EVALUATION_FAILED'
  | 'REQUEST_TRANSFORM_REQUEST_REBUILD_FAILED'
  | 'REQUEST_TRANSFORM_HEADER_FORBIDDEN';

export type ProviderRequestTransformLocation = {
  readonly ruleIndex: number;
  readonly ruleName?: string;
  readonly stageIndex?: number;
};

type ProviderRequestTransformErrorOptions = Partial<ProviderRequestTransformLocation> & {
  readonly code: ProviderRequestTransformErrorCode;
};

export class ProviderRequestTransformError extends Error {
  declare readonly code: ProviderRequestTransformErrorCode;
  declare readonly ruleIndex?: number;
  declare readonly ruleName?: string;
  declare readonly stageIndex?: number;

  constructor(options: ProviderRequestTransformErrorOptions) {
    super('Provider request transform failed');
    Object.defineProperty(this, 'name', { value: 'ProviderRequestTransformError' });
    this.code = options.code;
    if (options.ruleIndex !== undefined) this.ruleIndex = options.ruleIndex;
    if (options.ruleName !== undefined) this.ruleName = options.ruleName;
    if (options.stageIndex !== undefined) this.stageIndex = options.stageIndex;
  }
}

export function providerRequestTransformDiagnostic(error: unknown):
  | {
      readonly transformRuleIndex?: number;
      readonly transformRuleName?: string;
      readonly transformStageIndex?: number;
    }
  | undefined {
  if (!(error instanceof ProviderRequestTransformError)) return undefined;
  return {
    ...(error.ruleIndex === undefined ? {} : { transformRuleIndex: error.ruleIndex }),
    ...(error.ruleName === undefined ? {} : { transformRuleName: error.ruleName }),
    ...(error.stageIndex === undefined ? {} : { transformStageIndex: error.stageIndex }),
  };
}
