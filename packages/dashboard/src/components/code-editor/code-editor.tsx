import { cn } from '@aio-proxy/ui/lib/utils';
import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';

import { createCodeEditorContentAttributes } from './code-editor-accessibility';
import { createCodeEditorTheme } from './themes';

import styles from './code-editor.module.css';

interface CodeEditorProps {
  readonly value: string;
  readonly onChange?: (value: string) => void;
  readonly invalid?: boolean;
  readonly id?: string;
  readonly className?: string;
  readonly extensions?: Extension[];
}

const toThemeMode = (theme: string | undefined) => (theme === 'dark' ? 'dark' : 'light');

export const CodeEditor: React.FC<CodeEditorProps> = ({ className, invalid, id, onChange, value, extensions }) => {
  const { resolvedTheme } = useTheme();
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const themeCompartment = useRef(new Compartment());
  const a11yCompartment = useRef(new Compartment());
  const extraCompartment = useRef(new Compartment());

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!parentRef.current) return undefined;

    const view = new EditorView({
      parent: parentRef.current,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          json(),
          closeBrackets(),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          keymap.of([...completionKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const next = update.state.doc.toString();
            if (next !== valueRef.current) onChangeRef.current?.(next);
          }),
          themeCompartment.current.of(createCodeEditorTheme(toThemeMode(resolvedTheme))),
          a11yCompartment.current.of(
            EditorView.contentAttributes.of(createCodeEditorContentAttributes({ invalid, id })),
          ),
          extraCompartment.current.of(extensions ?? []),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once; later prop changes are applied through compartments.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(createCodeEditorTheme(toThemeMode(resolvedTheme))),
    });
  }, [resolvedTheme]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: a11yCompartment.current.reconfigure(
        EditorView.contentAttributes.of(createCodeEditorContentAttributes({ invalid, id })),
      ),
    });
  }, [id, invalid]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: extraCompartment.current.reconfigure(extensions ?? []),
    });
  }, [extensions]);

  return <div ref={parentRef} aria-invalid={invalid || undefined} className={cn(styles['code-editor'], className)} />;
};
