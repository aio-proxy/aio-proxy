import { Editor, loader } from "@monaco-editor/react";
import { merge } from "es-toolkit/object";
import * as monaco from "monaco-editor";
import { useTheme } from "next-themes";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import styles from "./code-editor.module.css";
import { CODE_EDITOR_THEME_IDS, defineCodeEditorThemes } from "./themes";

loader.config({
  monaco,
});

globalThis.MonacoEnvironment = {
  getWorker: (_workerId, label) => {
    switch (label) {
      case "json":
        return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), {
          type: "module",
        });
      case "css":
      case "less":
      case "scss":
        return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), {
          type: "module",
        });
      case "handlebars":
      case "html":
      case "razor":
        return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), {
          type: "module",
        });
      case "javascript":
      case "typescript":
        return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), {
          type: "module",
        });
      default:
        return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), {
          type: "module",
        });
    }
  },
};

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
