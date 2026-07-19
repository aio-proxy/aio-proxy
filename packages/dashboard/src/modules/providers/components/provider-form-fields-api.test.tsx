import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, rs, test } from "@rstest/core";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";

import { ProviderFormMode } from "../constants";
import { useProviderForm } from "../hooks/use-provider-form";
import { ProviderFormFieldsApi } from "./provider-form-fields-api";

describe("API provider form fields", () => {
  test("hydrates and submits the canonical baseURL field when editing", async () => {
    const onSubmit = rs.fn();
    const { result } = renderHook(() =>
      useProviderForm({
        mode: ProviderFormMode.Edit,
        kind: ProviderKind.Api,
        initial: {
          kind: ProviderKind.Api,
          id: "openrouter",
          enabled: true,
          protocol: ProviderProtocol.OpenAICompatible,
          baseURL: "https://openrouter.example/v1",
        },
        onSubmit,
      }),
    );

    render(
      <ProviderFormFieldsApi
        form={result.current}
        mode={ProviderFormMode.Edit}
        providerId="openrouter"
        aliasOpen={false}
        onAliasOpenChange={rs.fn()}
      />,
    );

    const baseURLInput = within(screen.getByTestId("provider-form-field-baseURL")).getByRole("textbox");
    expect(baseURLInput).toHaveValue("https://openrouter.example/v1");

    fireEvent.change(baseURLInput, { target: { value: "https://updated.example/v1" } });
    await act(async () => {
      await result.current.handleSubmit();
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0]?.[0];
    expect(submitted).toMatchObject({ baseURL: "https://updated.example/v1" });
    expect(submitted).not.toHaveProperty("baseUrl");
  });
});
