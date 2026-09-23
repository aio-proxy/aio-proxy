type JsonObject = Record<string, unknown>;

const base64Pattern = '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';
const geminiInlineDataMaxLength = 4 * Math.ceil((20 * 1024 * 1024) / 3);
const geminiInlineDataMaxUnpaddedLength = geminiInlineDataMaxLength - 4;
const imageMimeTypePattern = '^image/[A-Za-z0-9!#$&^_.+-]+$';
const trimmedModelPattern = (maxLength: number): string => `^\\s*(?:[\\s\\S]{1,${maxLength}})?\\s*$`;

// Runtime validation measures decoded bytes. An unpadded base64 string at the
// rounded-up encoded limit decodes one byte too many, while either padding form
// consumes that final quantum and remains within the 20 MiB limit.
const geminiInlineDataSchema = {
  anyOf: [
    { type: 'string', maxLength: geminiInlineDataMaxUnpaddedLength, pattern: base64Pattern },
    {
      type: 'string',
      maxLength: geminiInlineDataMaxLength,
      pattern: '^(?:[A-Za-z0-9+/]{4})*[A-Za-z0-9+/]{2}==$',
    },
    {
      type: 'string',
      maxLength: geminiInlineDataMaxLength,
      pattern: '^(?:[A-Za-z0-9+/]{4})*[A-Za-z0-9+/]{3}=$',
    },
  ],
};

const replaceObject = (target: JsonObject, source: JsonObject): void => {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
};

export const projectTrimmedModelSchemas = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) projectTrimmedModelSchemas(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const target = value as JsonObject;
  const trimmedMaxLength = target['x-aio-proxy-trimmed-max-length'];
  if (typeof trimmedMaxLength === 'number' && Number.isSafeInteger(trimmedMaxLength) && trimmedMaxLength >= 0) {
    delete target.maxLength;
    delete target['x-aio-proxy-trimmed-max-length'];
    target.pattern = trimmedModelPattern(trimmedMaxLength);
  }
  for (const child of Object.values(target)) projectTrimmedModelSchemas(child);
};

const rawVariant = (knownTypes: readonly string[]): JsonObject => ({
  type: 'object',
  properties: {
    type: {
      type: 'string',
      minLength: 1,
      pattern: `^(?!(?:${knownTypes.join('|')})$)[\\s\\S]+$`,
    },
  },
  required: ['type'],
  additionalProperties: true,
});

export function appendRawVariant(target: JsonObject, known: JsonObject, knownTypes: readonly string[]): void {
  const variants = Array.isArray(known.anyOf) ? known.anyOf : [known];
  replaceObject(target, { anyOf: [...variants, rawVariant(knownTypes)] });
}

export function projectGeminiMedia(target: JsonObject): void {
  const partItems = (target.properties as JsonObject | undefined) ?? {};
  const inlineData = partItems.inlineData as JsonObject | undefined;
  const inlineProperties = inlineData?.properties as JsonObject | undefined;
  if (inlineProperties?.data !== undefined) {
    inlineProperties.data = {
      ...(inlineProperties.data as JsonObject),
      ...geminiInlineDataSchema,
    };
  }
  const fileData = partItems.fileData as JsonObject | undefined;
  const fileProperties = fileData?.properties as JsonObject | undefined;
  if (fileProperties?.mimeType !== undefined) {
    fileProperties.mimeType = {
      ...(fileProperties.mimeType as JsonObject),
      pattern: imageMimeTypePattern,
    };
  }
  if (fileProperties?.fileUri !== undefined) {
    fileProperties.fileUri = {
      ...(fileProperties.fileUri as JsonObject),
      format: 'uri',
      pattern: '^[hH][tT][tT][pP][sS]?://',
    };
  }
  const responseParts = ((partItems.functionResponse as JsonObject | undefined)?.properties as JsonObject | undefined)
    ?.parts as JsonObject | undefined;
  const responseInline = ((responseParts?.items as JsonObject | undefined)?.properties as JsonObject | undefined)
    ?.inlineData as JsonObject | undefined;
  const responseData = (responseInline?.properties as JsonObject | undefined)?.data;
  if (responseData !== undefined) {
    responseInline!.properties = {
      ...(responseInline!.properties as JsonObject),
      data: { ...(responseData as JsonObject), ...geminiInlineDataSchema },
    };
  }
  const responseMimeType = (responseInline?.properties as JsonObject | undefined)?.mimeType;
  if (responseMimeType !== undefined) {
    responseInline!.properties = {
      ...(responseInline!.properties as JsonObject),
      mimeType: { ...(responseMimeType as JsonObject), pattern: imageMimeTypePattern },
    };
  }
}
