import { parseGeminiGenerateContent } from '../../index';

export const fixtureRoot = `${import.meta.dir}/../../../__tests__/fixtures/gemini-generate-content`;
export const inlineLimitBytes = 20 * 1024 * 1024;

export const validFixtures = [
  'simple-text.json',
  'system-instruction.json',
  'inline-data-vision.json',
  'function-call.json',
  'function-response-tools-safety.json',
  'file-data-vision.json',
] as const;

export async function readFixture(file: string): Promise<unknown> {
  return await Bun.file(`${fixtureRoot}/${file}`).json();
}

export { parseGeminiGenerateContent };
