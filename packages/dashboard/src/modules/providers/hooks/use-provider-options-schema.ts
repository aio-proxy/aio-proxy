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
  readonly schemaPackage: string | null;
  readonly schema: Readonly<Record<string, unknown>> | undefined;
  readonly warnings: readonly { readonly code: string; readonly path: string }[];
  readonly errorCode: string | undefined;
  readonly effect: ProviderOptionsSchemaEffect | undefined;
};

export type ProviderOptionsSchemaEvent =
  | { readonly type: "package_changed"; readonly packageName: string }
  | { readonly type: "package_committed"; readonly packageName: string }
  | { readonly type: "status_loaded"; readonly packageName: string; readonly status: ProviderPackageStatus }
  | { readonly type: "install_confirmed" }
  | { readonly type: "install_started" }
  | { readonly type: "install_succeeded"; readonly packageName: string }
  | { readonly type: "install_failed"; readonly packageName: string; readonly errorCode: string }
  | {
      readonly type: "schema_loaded";
      readonly packageName: string;
      readonly schema: Readonly<Record<string, unknown>>;
      readonly warnings: readonly { readonly code: string; readonly path: string }[];
    }
  | { readonly type: "schema_missing"; readonly packageName: string };

export const initialProviderOptionsSchemaState: ProviderOptionsSchemaState = {
  phase: "idle",
  committedPackage: null,
  schemaPackage: null,
  schema: undefined,
  warnings: [],
  errorCode: undefined,
  effect: undefined,
};

const isStaleCompletion = (state: ProviderOptionsSchemaState, event: ProviderOptionsSchemaEvent) =>
  "packageName" in event &&
  event.type !== "package_changed" &&
  event.type !== "package_committed" &&
  event.packageName !== state.committedPackage;

export const providerOptionsSchemaTransition = (
  state: ProviderOptionsSchemaState,
  event: ProviderOptionsSchemaEvent,
): ProviderOptionsSchemaState => {
  if (isStaleCompletion(state, event)) {
    return state;
  }

  switch (event.type) {
    case "package_changed":
      return initialProviderOptionsSchemaState;
    case "package_committed":
      return {
        ...initialProviderOptionsSchemaState,
        phase: "checking",
        committedPackage: event.packageName,
      };
    case "status_loaded":
      if (event.status.state === "missing") {
        return event.status.trusted
          ? { ...state, phase: "installing", effect: { type: "install", confirmed: false } }
          : { ...state, phase: "install_required", effect: undefined };
      }
      return event.status.schemaAvailable
        ? { ...state, phase: "loading_schema", effect: undefined }
        : { ...state, phase: "schema_unavailable", effect: undefined };
    case "install_confirmed":
      return state.phase === "install_required"
        ? { ...state, phase: "installing", effect: { type: "install", confirmed: true } }
        : state;
    case "install_started":
      return state.phase === "installing" ? { ...state, effect: undefined } : state;
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
  const attemptedAutomaticInstalls = useRef(new Set<string>());
  const queryClient = useQueryClient();
  const packageName = state.committedPackage;
  const statusQuery = useQuery({
    ...providerPackageStatusQueryOptions(packageName ?? ""),
    enabled: packageName !== null && state.phase === "checking",
  });
  const schemaQuery = useQuery({
    ...providerOptionsSchemaQueryOptions(packageName ?? ""),
    enabled: packageName !== null && state.phase === "loading_schema",
  });
  const installMutation = useMutation({
    mutationKey: ["providers", "install", packageName],
    mutationFn: installProviderPackage,
    onSuccess: async (_data, variables) => {
      dispatch({ type: "install_succeeded", packageName: variables.packageName });
      const options = providerPackageStatusQueryOptions(variables.packageName);
      await queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true });
      const status = await queryClient.fetchQuery(options);
      dispatch({ type: "status_loaded", packageName: variables.packageName, status });
    },
    onError: (error, variables) => {
      dispatch({ type: "install_failed", packageName: variables.packageName, errorCode: requestErrorCode(error) });
    },
  });

  useEffect(() => {
    if (packageName !== null && statusQuery.data !== undefined) {
      dispatch({ type: "status_loaded", packageName, status: statusQuery.data });
    }
  }, [packageName, statusQuery.data]);

  useEffect(() => {
    if (packageName !== null && statusQuery.error !== null) {
      dispatch({ type: "install_failed", packageName, errorCode: requestErrorCode(statusQuery.error) });
    }
  }, [packageName, statusQuery.error]);

  useEffect(() => {
    if (packageName !== null && schemaQuery.data !== undefined) {
      dispatch({
        type: "schema_loaded",
        packageName,
        schema: schemaQuery.data.schema,
        warnings: schemaQuery.data.warnings,
      });
    }
  }, [packageName, schemaQuery.data]);

  useEffect(() => {
    if (packageName !== null && schemaQuery.error !== null) {
      dispatch({ type: "schema_missing", packageName });
    }
  }, [packageName, schemaQuery.error]);

  useEffect(() => {
    if (packageName === null || state.effect?.type !== "install") {
      return;
    }
    if (!state.effect.confirmed) {
      if (attemptedAutomaticInstalls.current.has(packageName)) {
        return;
      }
      attemptedAutomaticInstalls.current.add(packageName);
    }
    dispatch({ type: "install_started" });
    installMutation.mutate({ packageName, confirmed: state.effect.confirmed });
  }, [packageName, state.effect, installMutation]);

  const changePackage = useCallback((nextPackageName: string) => {
    dispatch({ type: "package_changed", packageName: nextPackageName });
  }, []);
  const commitPackage = useCallback((nextPackageName: string) => {
    attemptedAutomaticInstalls.current.delete(nextPackageName);
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
