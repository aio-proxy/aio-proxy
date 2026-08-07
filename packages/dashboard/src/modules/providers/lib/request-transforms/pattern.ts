const REGEX_META = /[\\^$.*+?()[\]{}|]/u;

export const patternToRegex = (pattern: string): string => {
  let source = '';
  for (const character of pattern) {
    source += character === '*' ? '.*' : REGEX_META.test(character) ? `\\${character}` : character;
  }
  return `^(?:${source})$`;
};

export const regexToPattern = (regex: string): string | undefined => {
  if (!regex.startsWith('^(?:') || !regex.endsWith(')$')) return undefined;
  const source = regex.slice(4, -2);
  let pattern = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '.' && source[index + 1] === '*') {
      pattern += '*';
      index += 1;
    } else if (character === '\\' && index + 1 < source.length && REGEX_META.test(source[index + 1]!)) {
      pattern += source[index + 1]!;
      index += 1;
    } else if (REGEX_META.test(character)) {
      return undefined;
    } else {
      pattern += character;
    }
  }
  return patternToRegex(pattern) === regex ? pattern : undefined;
};
