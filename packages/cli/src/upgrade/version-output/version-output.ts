// `<bin> --version` prints the version inside a larger line. The prerelease
// suffix is part of the version and must survive the parse: a canary install
// reports `0.23.1-canary.4213.ga1b2c3d`, and dropping the suffix would leave the
// post-install check comparing `0.23.1` against the requested canary and roll a
// perfectly good binary back.
const VERSION = /(\d+\.\d+\.\d+(?:-[\w.-]+)?)/;

export const parseVersionOutput = (output: string): string | undefined => VERSION.exec(output)?.[1];
