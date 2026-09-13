export type GrokCompatOptions = {
  readonly grokBinary: string;
  readonly cliBinary: string;
  readonly expectedVersion: string;
  readonly reportPath: string;
};

export type GrokCompatReport = {
  readonly grokVersion: string;
  readonly cliVersion: string;
  readonly platform: string;
  readonly cases: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[];
};
