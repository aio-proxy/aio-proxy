export type CodeEditorAriaProps = {
  readonly invalid?: boolean;
  readonly id?: string;
};

export const createCodeEditorContentAttributes = ({ invalid, id }: CodeEditorAriaProps): Record<string, string> => ({
  ...(id === undefined ? {} : { id }),
  ...(invalid ? { 'aria-invalid': 'true' } : {}),
  ...(invalid && id !== undefined ? { 'aria-describedby': `${id}-error` } : {}),
});
