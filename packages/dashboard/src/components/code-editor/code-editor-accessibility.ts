type AttributeTarget = {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

type CodeEditorDomAccessor = {
  getDomNode(): {
    querySelector(selector: string): AttributeTarget | null;
  } | null;
};

export const setCodeEditorAriaInvalid = (
  editor: CodeEditorDomAccessor,
  invalid: boolean | undefined,
  ariaDescribedBy?: string,
) => {
  const textbox = editor.getDomNode()?.querySelector('textarea.inputarea, [role="textbox"]');
  if (invalid) textbox?.setAttribute("aria-invalid", "true");
  else textbox?.removeAttribute("aria-invalid");
  if (ariaDescribedBy) textbox?.setAttribute("aria-describedby", ariaDescribedBy);
  else textbox?.removeAttribute("aria-describedby");
};
