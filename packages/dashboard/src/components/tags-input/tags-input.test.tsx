import { describe, expect, test } from "@rstest/core";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { useState } from "react";
import { TagsInput } from "./tags-input";

interface TagsInputHarnessProps {
  readonly options?: readonly string[];
}

const TagsInputHarness: React.FC<TagsInputHarnessProps> = ({ options = [] }) => {
  const [value, setValue] = useState<string[]>([]);
  return (
    <>
      <label htmlFor="models">Models</label>
      <TagsInput
        id="models"
        value={value}
        onValueChange={setValue}
        placeholder="Add model"
        removeLabel={(tag) => `Remove ${tag}`}
        options={options}
      />
      <output aria-label="Selected models">{value.join("|")}</output>
    </>
  );
};

describe("TagsInput", () => {
  test("creates trimmed unique values from keys, blur, and paste", () => {
    render(<TagsInputHarness />);
    const input = screen.getByRole("combobox", { name: "Models" });
    const selected = screen.getByRole("status", { name: "Selected models" });

    fireEvent.change(input, { target: { value: " gpt-5 " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "gpt-5" } });
    fireEvent.keyDown(input, { key: "," });
    fireEvent.paste(input, { clipboardData: { getData: () => "claude-4\ngemini-2, gpt-5" } });
    fireEvent.change(input, { target: { value: "mistral-large" } });
    fireEvent.blur(input);

    expect(selected).toHaveTextContent("gpt-5|claude-4|gemini-2|mistral-large");
  });

  test("selects a highlighted suggestion without creating the search draft", async () => {
    render(<TagsInputHarness options={["gpt-5", "gpt-5-mini"]} />);
    const input = screen.getByRole("combobox", { name: "Models" });

    fireEvent.click(input);
    fireEvent.input(input, { target: { value: "gpt-5" }, inputType: "insertText" });
    await screen.findByRole("option", { name: "gpt-5" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("status", { name: "Selected models" })).toHaveTextContent("gpt-5");
  });

  test("preserves accessibility and does not clear values on Escape or IME Enter", () => {
    render(<TagsInputHarness />);
    const input = screen.getByRole("combobox", { name: "Models" });

    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, which: 229 });
    expect(screen.getByRole("status", { name: "Selected models" })).toBeEmptyDOMElement();

    fireEvent.change(input, { target: { value: "gpt-5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("status", { name: "Selected models" })).toHaveTextContent("gpt-5");

    fireEvent.click(screen.getByRole("button", { name: "Remove gpt-5" }));
    expect(screen.getByRole("status", { name: "Selected models" })).toBeEmptyDOMElement();
  });
});
