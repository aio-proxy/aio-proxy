import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  installProviderPackage,
  ProviderPackageRequestError,
  providerOptionsSchemaQueryOptions,
  providerPackageStatusQueryOptions,
} from "../services/provider-options-schema-service";

export type ProviderOptionsSchemaPhase =
  | "idle"
  | "checking"
  | "installing"
  | "install_deferred"
  | "install_required"
  | "loading_schema"
  | "ready"
  | "schema_unavailable"
  | "schema_error"
  | "status_error"
  | "install_error";

export type ProviderOptionsSchemaResolution = "unknown" | "loading" | "ready" | "unavailable" | "error";

type ProviderPackageStatus = {
  readonly trusted: boolean;
  readonly state: "bundled" | "installed" | "missing";
  readonly schemaAvailable: boolean;
};

type ProviderOptionsSchemaEffect = { readonly type: "install"; readonly confirmed: boolean };

export type ProviderOptionsSchemaState = {
  readonly phase: ProviderOptionsSchemaPhase;
  readonly committedPackage: string | null;
  readonly commitGeneration: number;
  readonly automaticInstallAttempted: boolean;
  readonly allowAutomaticInstall: boolean;
  readonly schemaResolution: ProviderOptionsSchemaResolution;
  readonly schemaPackage: string | null;
  readonly schema: Readonly<Record<string, unknown>> | undefined;
  readonly warnings: readonly { readonly code: string; readonly path: string }[];
  readonly errorCode: string | undefined;
  readonly effect: ProviderOptionsSchemaEffect | undefined;
};

export type ProviderOptionsSchemaEvent =
  | { readonly type: "package_changed"; readonly packageName: string }
  | { readonly type: "package_committed"; readonly packageName: string; readonly allowAutomaticInstall?: boolean }
  | {
      readonly type: "status_loaded";
      readonly packageName: string;
      readonly generation: number;
      readonly status: ProviderPackageStatus;
    }
  | {
      readonly type: "status_failed";
      readonly packageName: string;
      readonly generation: number;
      readonly errorCode: string;
    }
  | { readonly type: "install_confirmed" }
  | { readonly type: "install_started" }
  | { readonly type: "install_succeeded"; readonly packageName: string; readonly generation: number }
  | {
      readonly type: "install_failed";
      readonly packageName: string;
      readonly generation: number;
      readonly errorCode: string;
    }
  | {
      readonly type: "schema_loaded";
      readonly packageName: string;
      readonly generation: number;
      readonly schema: Readonly<Record<string, unknown>>;
      readonly warnings: readonly { readonly code: string; readonly path: string }[];
    }
  | { readonly type: "schema_missing"; readonly packageName: string; readonly generation: number }
  | {
      readonly type: "schema_failed";
      readonly packageName: string;
      readonly generation: number;
      readonly errorCode: string;
    };

export const initialProviderOptionsSchemaState: ProviderOptionsSchemaState = {
  phase: "idle",
  committedPackage: null,
  commitGeneration: 0,
  automaticInstallAttempted: false,
  allowAutomaticInstall: false,
  schemaResolution: "unknown",
  schemaPackage: null,
  schema: undefined,
  warnings: [],
  errorCode: undefined,
  effect: undefined,
};

const rejectsCompletion = (state: ProviderOptionsSchemaState, event: ProviderOptionsSchemaEvent) => {
  if (!("generation" in event)) {
    return false;
  }
  if (event.packageName !== state.committedPackage || event.generation !== state.commitGeneration) return true;
  switch (event.type) {
    case "status_loaded":
    case "status_failed":
      return state.phase !== "checking";
    case "install_succeeded":
    case "install_failed":
      return state.phase !== "installing";
    case "schema_loaded":
    case "schema_missing":
    case "schema_failed":
      return state.schemaResolution !== "loading" && state.phase !== "loading_schema";
  }
};

const resolveSchemaAvailability = (state: ProviderOptionsSchemaState, schemaAvailable: boolean) => {
  if (!schemaAvailable) {
    return {
      ...state,
      schemaResolution: "unavailable" as const,
      schemaPackage: null,
      schema: undefined,
      warnings: [],
    };
  }
  if (state.schemaResolution === "ready" && state.schemaPackage === state.committedPackage) return state;
  return {
    ...state,
    schemaResolution: "loading" as const,
    schemaPackage: null,
    schema: undefined,
    warnings: [],
  };
};

export const providerOptionsSchemaTransition = (
  state: ProviderOptionsSchemaState,
  event: ProviderOptionsSchemaEvent,
): ProviderOptionsSchemaState => {
  if (rejectsCompletion(state, event)) {
    return state;
  }

  switch (event.type) {
    case "package_changed":
      return { ...initialProviderOptionsSchemaState, commitGeneration: state.commitGeneration };
    case "package_committed":
      return {
        ...initialProviderOptionsSchemaState,
        phase: "checking",
        committedPackage: event.packageName,
        commitGeneration: state.commitGeneration + 1,
        allowAutomaticInstall: event.allowAutomaticInstall ?? true,
      };
    case "status_loaded": {
      const schemaState = resolveSchemaAvailability(state, event.status.schemaAvailable);
      if (event.status.state === "missing") {
        if (event.status.trusted && state.automaticInstallAttempted) {
          return { ...schemaState, phase: "install_error", effect: undefined, errorCode: "package_still_missing" };
        }
        if (!event.status.trusted) return { ...schemaState, phase: "install_required", effect: undefined };
        return state.allowAutomaticInstall
          ? { ...schemaState, phase: "installing", effect: { type: "install", confirmed: false } }
          : { ...schemaState, phase: "install_deferred", effect: undefined };
      }
      return schemaState.schemaResolution === "ready"
        ? { ...schemaState, phase: "ready", effect: undefined }
        : event.status.schemaAvailable
          ? { ...schemaState, phase: "loading_schema", effect: undefined }
          : { ...schemaState, phase: "schema_unavailable", effect: undefined };
    }
    case "status_failed":
      return {
        ...state,
        phase: "status_error",
        schemaResolution: "error",
        schemaPackage: null,
        schema: undefined,
        warnings: [],
        effect: undefined,
        errorCode: event.errorCode,
      };
    case "install_confirmed":
      return state.phase === "install_required"
        ? { ...state, phase: "installing", effect: { type: "install", confirmed: true } }
        : state;
    case "install_started":
      return state.phase === "installing"
        ? {
            ...state,
            automaticInstallAttempted: state.automaticInstallAttempted || state.effect?.confirmed === false,
            effect: undefined,
          }
        : state;
    case "install_succeeded":
      return { ...state, phase: "checking", effect: undefined, errorCode: undefined };
    case "install_failed":
      return { ...state, phase: "install_error", effect: undefined, errorCode: event.errorCode };
    case "schema_loaded":
      return {
        ...state,
        phase: state.phase === "loading_schema" ? "ready" : state.phase,
        schemaResolution: "ready",
        schemaPackage: event.packageName,
        schema: event.schema,
        warnings: event.warnings,
        errorCode: state.phase === "install_error" ? state.errorCode : undefined,
      };
    case "schema_missing":
      return {
        ...state,
        phase: state.phase === "loading_schema" ? "schema_unavailable" : state.phase,
        schemaResolution: "unavailable",
        schemaPackage: null,
        schema: undefined,
        warnings: [],
      };
    case "schema_failed":
      return {
        ...state,
        phase: state.phase === "loading_schema" ? "schema_error" : state.phase,
        schemaResolution: "error",
        schemaPackage: null,
        schema: undefined,
        warnings: [],
        errorCode: event.errorCode,
      };
  }
};

export type UseProviderOptionsSchemaResult = {
  readonly phase: ProviderOptionsSchemaPhase;
  readonly schemaResolution: ProviderOptionsSchemaResolution;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly warnings: readonly { code: string; path: string }[];
  readonly packageName: string | null;
  readonly changePackage: (packageName: string) => void;
  readonly commitPackage: (packageName: string, allowAutomaticInstall?: boolean) => void;
  readonly requestInstall: () => void;
  readonly confirmInstall: () => void;
  readonly errorCode?: string;
};

const requestErrorCode = (error: unknown) =>
  error instanceof ProviderPackageRequestError ? error.code : "request_failed";

type RefetchResult<T> = { readonly data: T | undefined; readonly error: unknown };

export const providerStatusRefetchEvent = <T extends ProviderPackageStatus>(
  packageName: string,
  generation: number,
  result: RefetchResult<T>,
): ProviderOptionsSchemaEvent => {
  if (result.error !== null && result.error !== undefined) {
    return { type: "status_failed", packageName, generation, errorCode: requestErrorCode(result.error) };
  }
  return result.data === undefined
    ? { type: "status_failed", packageName, generation, errorCode: "request_failed" }
    : { type: "status_loaded", packageName, generation, status: result.data };
};

type ProviderSchemaData = {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly warnings: readonly { readonly code: string; readonly path: string }[];
};

export const providerSchemaRefetchEvent = <T extends ProviderSchemaData>(
  packageName: string,
  generation: number,
  result: RefetchResult<T>,
): ProviderOptionsSchemaEvent => {
  if (result.error !== null && result.error !== undefined) {
    return result.error instanceof ProviderPackageRequestError && result.error.code === "schema_unavailable"
      ? { type: "schema_missing", packageName, generation }
      : { type: "schema_failed", packageName, generation, errorCode: requestErrorCode(result.error) };
  }
  return result.data === undefined
    ? { type: "schema_failed", packageName, generation, errorCode: "request_failed" }
    : {
        type: "schema_loaded",
        packageName,
        generation,
        schema: result.data.schema,
        warnings: result.data.warnings,
      };
};

export function useProviderOptionsSchema(): UseProviderOptionsSchemaResult {
  const [state, dispatch] = useReducer(providerOptionsSchemaTransition, initialProviderOptionsSchemaState);
  const startedInstalls = useRef(new Set<number>());
  const queryClient = useQueryClient();
  const packageName = state.committedPackage;
  const generation = state.commitGeneration;
  const statusQuery = useQuery({
    ...providerPackageStatusQueryOptions(packageName ?? ""),
    enabled: false,
  });
  const schemaQuery = useQuery({
    ...providerOptionsSchemaQueryOptions(packageName ?? ""),
    enabled: false,
  });
  const installMutation = useMutation({
    mutationKey: ["providers", "install", packageName, generation],
    mutationFn: ({
      packageName: mutationPackage,
      confirmed,
    }: {
      packageName: string;
      generation: number;
      confirmed: boolean;
    }) => installProviderPackage({ packageName: mutationPackage, confirmed }),
    onSuccess: async (_data, variables) => {
      dispatch({ type: "install_succeeded", packageName: variables.packageName, generation: variables.generation });
      const options = providerPackageStatusQueryOptions(variables.packageName);
      await queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true });
    },
    onError: (error, variables) => {
      dispatch({
        type: "install_failed",
        packageName: variables.packageName,
        generation: variables.generation,
        errorCode: requestErrorCode(error),
      });
    },
  });

  useEffect(() => {
    if (packageName === null || state.phase !== "checking") {
      return;
    }
    void statusQuery.refetch().then((result) => dispatch(providerStatusRefetchEvent(packageName, generation, result)));
  }, [generation, packageName, state.phase, statusQuery.refetch]);

  useEffect(() => {
    if (packageName === null || state.schemaResolution !== "loading") {
      return;
    }
    void schemaQuery.refetch().then((result) => dispatch(providerSchemaRefetchEvent(packageName, generation, result)));
  }, [generation, packageName, schemaQuery.refetch, state.schemaResolution]);

  useEffect(() => {
    if (packageName === null || state.effect?.type !== "install") {
      return;
    }
    if (startedInstalls.current.has(generation)) {
      dispatch({ type: "install_started" });
      return;
    }
    startedInstalls.current.add(generation);
    dispatch({ type: "install_started" });
    installMutation.mutate({ packageName, generation, confirmed: state.effect.confirmed });
  }, [generation, packageName, state.effect, installMutation]);

  const changePackage = useCallback((nextPackageName: string) => {
    dispatch({ type: "package_changed", packageName: nextPackageName });
  }, []);
  const commitPackage = useCallback((nextPackageName: string, allowAutomaticInstall = true) => {
    dispatch({ type: "package_committed", packageName: nextPackageName, allowAutomaticInstall });
  }, []);
  const requestInstall = useCallback(() => {
    if (packageName !== null) {
      dispatch({ type: "package_committed", packageName, allowAutomaticInstall: true });
    }
  }, [packageName]);
  const confirmInstall = useCallback(() => dispatch({ type: "install_confirmed" }), []);

  return {
    phase: state.phase,
    schemaResolution: state.schemaResolution,
    warnings: state.warnings,
    packageName,
    changePackage,
    commitPackage,
    requestInstall,
    confirmInstall,
    ...(state.schema === undefined ? {} : { schema: state.schema }),
    ...(state.errorCode === undefined ? {} : { errorCode: state.errorCode }),
  };
}
