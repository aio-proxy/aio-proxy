import { m } from '@aio-proxy/i18n';
import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { SectionShell } from './section-shell';

// A healthy section is the case the old conditional badge dropped: restoring `status === 'ok' ? null`
// must red here, because "this section is done" is exactly what the badge affirms.
test('a ready section still shows its badge, its hint and its description', () => {
  render(
    <SectionShell
      id="routing"
      title={m['dashboard.providers.editor.section_routing']()}
      description={m['dashboard.providers.editor.section_routing_description']()}
      status="ok"
      statusHint={m['dashboard.providers.editor.hint_routing_weight']({ weight: 40 })}
    >
      <p>body</p>
    </SectionShell>,
  );

  expect(screen.getByText(m['dashboard.providers.editor.hint_routing_weight']({ weight: 40 }))).toBeTruthy();
  expect(screen.getByText(m['dashboard.providers.editor.section_routing_description']())).toBeTruthy();
});

// Both jump surfaces (the nav strip and the footer's error-recovery links) call `focus()` on this
// element. Without `tabIndex={-1}` a `<section>` is not programmatically focusable, so that call is a
// silent no-op and focus stays on the control the user left.
test('the section is a programmatically focusable jump target', () => {
  render(
    <SectionShell
      id="routing"
      title={m['dashboard.providers.editor.section_routing']()}
      description={m['dashboard.providers.editor.section_routing_description']()}
      status="ok"
      statusHint={m['dashboard.providers.editor.hint_routing_weight']({ weight: 40 })}
    >
      <p>body</p>
    </SectionShell>,
  );

  const section = document.getElementById('editor-routing');
  expect(section).toHaveAttribute('tabindex', '-1');
  section?.focus();
  expect(document.activeElement).toBe(section);
});
