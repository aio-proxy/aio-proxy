import { afterEach, expect, rs, test } from "@rstest/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";

import { DeleteProviderDialog, type DeleteProviderDialogRef } from "./delete-provider-dialog";

const mocks = rs.hoisted(() => ({ mutate: rs.fn() }));

rs.mock("../hooks/use-provider-mutations", () => ({
  useProviderDelete: () => ({ mutate: mocks.mutate, isPending: false }),
}));

afterEach(() => {
  mocks.mutate.mockReset();
});

test("notifies the edit page after a confirmed Provider deletion", () => {
  const onDeleted = rs.fn();
  const ref = createRef<DeleteProviderDialogRef>();
  mocks.mutate.mockImplementation((_id, options) => options.onSuccess());

  render(<DeleteProviderDialog ref={ref} onDeleted={onDeleted} />);
  act(() => ref.current?.open({ id: "carpool" }));
  fireEvent.click(screen.getByTestId("delete-confirm"));

  expect(mocks.mutate).toHaveBeenCalledWith("carpool", expect.any(Object));
  expect(onDeleted).toHaveBeenCalledTimes(1);
});
