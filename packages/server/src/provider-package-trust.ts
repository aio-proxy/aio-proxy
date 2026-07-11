const trustedProviderPackages = [new Bun.Glob("@ai-sdk/**")];

export const isTrustedProviderPackage = (packageName: string): boolean =>
  trustedProviderPackages.some((glob) => glob.match(packageName));
