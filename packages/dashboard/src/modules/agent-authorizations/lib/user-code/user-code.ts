export const normalizeAgentUserCode = (value: string): string => {
  const raw = value
    .toUpperCase()
    .replaceAll(/[^A-HJ-NP-Z2-9]/gu, '')
    .slice(0, 8);
  return raw.length <= 4 ? raw : `${raw.slice(0, 4)}-${raw.slice(4)}`;
};
