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
  | "install_required"
  | "loading_schema"
  | "ready"
  | "schema_unavailable"
  | "schema_error"
  | "install_error";

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
  readonly schemaPackage: string | null;
  readonly schema: Readonly<Record<string, unknown>> | undefined;
  readonly warnings: readonly { readonly code: string; readonly path: string }[];
  readonly errorCode: string | undefined;
  readonly effect: ProviderOptionsSchemaEffect | undefined;
};

export type ProviderOptionsSchemaEvent =
  | { readonly type: "package_changed"; readonly packageName: string }
  | { readonly type: "package_committed"; readonly packageName: string }
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
  schemaPackage: null,
  schema: undefined,
  warnings: [],
  errorCode: undefined,
  effect: undefined,
};

const completionPhase = (event: ProviderOptionsSchemaEvent): ProviderOptionsSchemaPhase | undefined => {
  switch (event.type) {
    case "status_loaded":
    case "status_failed":
      return "checking";
    case "install_succeeded":
    case "install_failed":
      return "installing";
    case "schema_loaded":
    case "schema_missing":
    case "schema_failed":
      return "loading_schema";
    default:
      return undefined;
  }
};

const rejectsCompletion = (state: ProviderOptionsSchemaState, event: ProviderOptionsSchemaEvent) => {
  if (!("generation" in event)) {
    return false;
  }
  const expectedPhase = completionPhase(event);
  return (
    expectedPhase !== undefined &&
    (event.packageName !== state.committedPackage ||
      event.generation !== state.commitGeneration ||
      state.phase !== expectedPhase)
  );
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
      };
    case "status_loaded":
      if (event.status.state === "missing") {
        if (event.status.trusted && state.automaticInstallAttempted) {
          return { ...state, phase: "install_error", effect: undefined, errorCode: "package_still_missing" };
        }
        return event.status.trusted
          ? { ...state, phase: "installing", effect: { type: "install", confirmed: false } }
          : { ...state, phase: "install_required", effect: undefined };
      }
      return event.status.schemaAvailable
        ? { ...state, phase: "loading_schema", effect: undefined }
        : { ...state, phase: "schema_unavailable", effect: undefined };
    case "status_failed":
      return { ...state, phase: "install_error", effect: undefined, errorCode: event.errorCode };
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
        phase: "ready",
        schemaPackage: event.packageName,
        schema: event.schema,
        warnings: event.warnings,
        errorCode: undefined,
      };
    case "schema_missing":
      return {
        ...state,
        phase: "schema_unavailable",
        schemaPackage: null,
        schema: undefined,
        warnings: [],
      };
    case "schema_failed":
      return {
        ...state,
        phase: "schema_error",
        schemaPackage: null,
        schema: undefined,
        warnings: [],
        errorCode: event.errorCode,
      };
  }
};

export type UseProviderOptionsSchemaResult = {
  readonly phase: ProviderOptionsSchemaPhase;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly warnings: readonly { code: string; path: string }[];
  readonly packageName: string | null;
  readonly changePackage: (packageName: string) => void;
  readonly commitPackage: (packageName: string) => void;
  readonly confirmInstall: () => void;
  readonly errorCode?: string;
};

const requestErrorCode = (error: unknown) =>
  error instanceof ProviderPackageRequestError ? error.code : "request_failed";

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
    void statusQuery
      .refetch()
      .then(({ data, error }) =>
        data === undefined
          ? dispatch({ type: "status_failed", packageName, generation, errorCode: requestErrorCode(error) })
          : dispatch({ type: "status_loaded", packageName, generation, status: data }),
      );
  }, [generation, packageName, state.phase, statusQuery.refetch]);

  useEffect(() => {
    if (packageName === null || state.phase !== "loading_schema") {
      return;
    }
    void schemaQuery.refetch().then(({ data, error }) => {
      if (data !== undefined) {
        dispatch({ type: "schema_loaded", packageName, generation, schema: data.schema, warnings: data.warnings });
      } else if (error instanceof ProviderPackageRequestError && error.code === "schema_unavailable") {
        dispatch({ type: "schema_missing", packageName, generation });
      } else {
        dispatch({ type: "schema_failed", packageName, generation, errorCode: requestErrorCode(error) });
      }
    });
  }, [generation, packageName, schemaQuery.refetch, state.phase]);

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
  const commitPackage = useCallback((nextPackageName: string) => {
    dispatch({ type: "package_committed", packageName: nextPackageName });
  }, []);
  const confirmInstall = useCallback(() => dispatch({ type: "install_confirmed" }), []);

  return {
    phase: state.phase,
    warnings: state.warnings,
    packageName,
    changePackage,
    commitPackage,
    confirmInstall,
    ...(state.schema === undefined ? {} : { schema: state.schema }),
    ...(state.errorCode === undefined ? {} : { errorCode: state.errorCode }),
  };
}
