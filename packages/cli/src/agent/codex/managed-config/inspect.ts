import { readCodexDocument, readManagedField, type ValueSlot } from '../config-document';
import type { CodexLocation, CodexMarker, ConfigInspection } from '../contracts';
import { readMarker } from './marker';
import { readRegularFile } from './storage';

export const equalSlot = (left: ValueSlot, right: ValueSlot): boolean => {
  if (!left.present || !right.present) return left.present === right.present;
  if (Array.isArray(left.value) || Array.isArray(right.value)) {
    if (!Array.isArray(left.value) || !Array.isArray(right.value)) return false;
    const rightValues = right.value as readonly string[];
    return left.value.length === rightValues.length && left.value.every((value, index) => value === rightValues[index]);
  }
  return left.value === right.value;
};

const inspectionAuth = (marker: CodexMarker): Pick<ConfigInspection, 'authMode' | 'installationId'> =>
  marker.format === 2
    ? {
        authMode: marker.authMode,
        ...(marker.authMode === 'command' ? { installationId: marker.installationId } : {}),
      }
    : { authMode: 'keep-chatgpt' };

export const changedFields = (marker: CodexMarker, text: string): readonly (readonly string[])[] =>
  marker.fields.flatMap((field) => (equalSlot(readManagedField(text, field.path), field.applied) ? [] : [field.path]));

export async function inspectCodexConfig(location: CodexLocation): Promise<ConfigInspection> {
  const current = await readRegularFile(location.configPath);
  if (current === undefined) {
    let marker: CodexMarker | undefined;
    try {
      marker = await readMarker(location);
    } catch {
      return { status: 'conflict', activeProviderId: '', changedPaths: [] };
    }
    if (marker === undefined) return { status: 'absent', activeProviderId: '', changedPaths: [] };
    return {
      status: 'absent',
      providerId: marker.providerId,
      activeProviderId: '',
      changedPaths: [],
      ...inspectionAuth(marker),
    };
  }
  let document: ReturnType<typeof readCodexDocument>;
  try {
    document = readCodexDocument(current.text);
  } catch {
    return { status: 'conflict', activeProviderId: '', changedPaths: [] };
  }
  let marker: CodexMarker | undefined;
  try {
    marker = await readMarker(location);
  } catch {
    return { status: 'conflict', activeProviderId: document.activeProviderId, changedPaths: [] };
  }
  if (marker === undefined) return { status: 'absent', activeProviderId: document.activeProviderId, changedPaths: [] };
  const changedPaths = changedFields(marker, current.text);
  const base = readManagedField(current.text, ['model_providers', marker.providerId, 'base_url']);
  const token = readManagedField(current.text, ['model_providers', marker.providerId, 'experimental_bearer_token']);
  return {
    status: changedPaths.length === 0 ? 'managed' : 'modified',
    providerId: marker.providerId,
    activeProviderId: document.activeProviderId,
    baseUrl: base.present && typeof base.value === 'string' ? base.value : undefined,
    ...(token.present && typeof token.value === 'string' ? { bearerToken: token.value } : {}),
    ...inspectionAuth(marker),
    changedPaths,
  };
}
