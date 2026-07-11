import { Editor } from "@monaco-editor/react";
import { merge } from "es-toolkit/object";
import { useTheme } from "next-themes";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import styles from "./code-editor.module.css";
import { CODE_EDITOR_THEME_IDS, defineCodeEditorThemes } from "./themes";

type MonacoEditorProps = React.ComponentProps<typeof Editor>;

interface CodeEditorProps extends Omit<MonacoEditorProps, "beforeMount" | "loading" | "theme"> {}

type MonacoOptions = NonNullable<CodeEditorProps["options"]>;

export const CodeEditor: React.FC<CodeEditorProps> = ({ className, options, ...rest }) => {
  const { resolvedTheme } = useTheme();

  return (
    <div className={cn(styles["code-editor"], className)}>
      <Editor
        {...rest}
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
