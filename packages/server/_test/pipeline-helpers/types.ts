import type { TextStreamPart, ToolSet } from "@aio-proxy/core";
import type { RequestAttemptInput, RequestFinishInput, RequestRecorder } from "../../src/request-recorder";
import type { ModelTransport, RuntimeProviderInstance } from "../../src/runtime";

export const REQUESTED_MODEL = "test-model";
export type ModelPart = TextStreamPart<ToolSet>;
type ModelCall = Parameters<ModelTransport["invoke"]>[0];

export type TestProtocolRequest = {
  readonly model: string;
  readonly prompt: string;
  readonly stream: boolean;
};

export type TestProtocolContext = {
  modelInvocationCalls: number;
  parseCalls: number;
  rawRequestCalls: number;
};

export type FakeProvider = {
  readonly calls: {
    ensure: number;
    model: ModelCall[];
    raw: Request[];
  };
  readonly provider: RuntimeProviderInstance;
};

export type Recording = {
  readonly begins: Parameters<RequestRecorder["begin"]>[0][];
  readonly identities: { readonly requestedModelId: string }[];
  readonly attempts: RequestAttemptInput[];
  readonly finals: RequestFinishInput[];
};
