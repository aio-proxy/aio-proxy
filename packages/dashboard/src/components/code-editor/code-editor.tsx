import { Editor, type OnMount } from "@monaco-editor/react";
import { merge } from "es-toolkit/object";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import styles from "./code-editor.module.css";
import { setCodeEditorAriaInvalid } from "./code-editor-accessibility";
import { CODE_EDITOR_THEME_IDS, defineCodeEditorThemes } from "./themes";

type MonacoEditorProps = React.ComponentProps<typeof Editor>;

interface CodeEditorProps extends Omit<MonacoEditorProps, "beforeMount" | "loading" | "theme"> {
  readonly invalid?: boolean;
  readonly ariaDescribedBy?: string;
}

type MonacoOptions = NonNullable<CodeEditorProps["options"]>;

export const CodeEditor: React.FC<CodeEditorProps> = ({
  className,
  invalid,
  ariaDescribedBy,
  onMount,
  options,
  ...rest
}) => {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<Parameters<OnMount>[0]>(null);
  const invalidRef = useRef(invalid);
  const ariaDescribedByRef = useRef(ariaDescribedBy);
  const onMountRef = useRef(onMount);
  invalidRef.current = invalid;
  ariaDescribedByRef.current = ariaDescribedBy;
  onMountRef.current = onMount;

  useEffect(() => {
    if (editorRef.current) setCodeEditorAriaInvalid(editorRef.current, invalid, ariaDescribedBy);
  }, [ariaDescribedBy, invalid]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    setCodeEditorAriaInvalid(editor, invalidRef.current, ariaDescribedByRef.current);
    onMountRef.current?.(editor, monaco);
  };

  return (
    <div
      aria-describedby={ariaDescribedBy}
      aria-invalid={invalid || undefined}
      className={cn(styles["code-editor"], className)}
    >
      <Editor
        {...rest}
        onMount={handleMount}
        loading={<Spinner />}
        options={merge<MonacoOptions, MonacoOptions>(
          {
            minimap: {
              enabled: false,
            },
            scrollbar: {
              verticalHasArrows: false,
              horizontalHasArrows: false,
              verticalScrollbarSize: 8,
              horizontalScrollbarSize: 8,
            },
          },
          options ?? {},
        )}
        theme={resolvedTheme === "dark" ? CODE_EDITOR_THEME_IDS.dark : CODE_EDITOR_THEME_IDS.light}
        beforeMount={defineCodeEditorThemes}
      />
    </div>
  );
};
