import { expect, test } from '@rstest/core';
import { render } from '@testing-library/react';

import { STATUS_CLASS, StatusDot } from './status-dot';

// D-F1 as amended: the loudest colour marks the state that DISABLES Save. The prototype's palette
// (`attention: bg-destructive`, `todo: bg-transparent ring-1 ring-muted-foreground/50`), which is what
// shipped before this fix, reads severity backwards — restoring either half must red here.
test('the save-blocking status wears the error colour and the savable one never does', () => {
  expect(STATUS_CLASS.todo).toBe('bg-destructive');
  expect(STATUS_CLASS.attention).toBe('bg-amber-600 dark:bg-amber-400');
  expect(STATUS_CLASS.ok).toBe('bg-primary');
  // The inverted-severity mutant this whole ruling exists to kill.
  expect(STATUS_CLASS.attention).not.toContain('destructive');
});

// The dot is the only per-status signal in the nav rail, so two statuses sharing one value — a copy
// -paste in the record, or a typo that collapses to the same token — erases a state silently.
test('no two statuses render the same dot', () => {
  expect(new Set(Object.values(STATUS_CLASS)).size).toBe(3);
});

// Dropping `${STATUS_CLASS[status]}` from the className still renders a dot, just a colourless one.
// `aria-hidden` is deliberate (the hint text beside it carries the meaning), so it is pinned too.
test('the rendered dot carries its status class and stays decorative', () => {
  const { container } = render(<StatusDot status="todo" />);

  const dot = container.querySelector('span');
  expect(dot?.className).toContain(STATUS_CLASS.todo);
  expect(dot?.getAttribute('aria-hidden')).toBe('true');
});
