import { beforeAll, describe, expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

// `@aio-proxy/ui` has no test harness, and its `components/` directory is shadcn-managed (see that
// directory's AGENTS.md), so these tests cannot be colocated with the source. The dashboard is the
// only consumer and already renders ui components under test.
//
// `supportsNativeSwitch` is resolved once at module load from the reflected `switch` IDL property,
// which happy-dom does not implement. Defining it here — before the first dynamic import evaluates
// the module — is what puts this file on the native branch. The unsupported branch needs the
// opposite global state, so it lives in switch-fallback.test.tsx: rstest isolates module registries
// per file, and resetModules() would re-instantiate React and break the renderer.
type SwitchComponent = (typeof import('@aio-proxy/ui/components/switch'))['Switch'];

let Switch: SwitchComponent;

beforeAll(async () => {
  Object.defineProperty(HTMLInputElement.prototype, 'switch', {
    configurable: true,
    value: false,
    writable: true,
  });
  ({ Switch } = await import('@aio-proxy/ui/components/switch'));
});

describe('Switch on a browser with native switch support', () => {
  test('renders the native input and reports toggles through onCheckedChange', () => {
    const changes: boolean[] = [];
    render(<Switch aria-label="Native" checked={false} onCheckedChange={(next) => changes.push(next)} />);

    const control = screen.getByLabelText('Native');
    expect(control.tagName).toBe('INPUT');
    expect(control).toHaveAttribute('switch');
    expect(control).not.toBeChecked();

    fireEvent.click(control);
    expect(changes).toEqual([true]);
  });

  test('keeps the Base UI implementation for the sm size it cannot reproduce natively', () => {
    render(<Switch aria-label="Small" size="sm" checked={false} onCheckedChange={() => undefined} />);

    expect(screen.getByLabelText('Small').tagName).not.toBe('INPUT');
  });

  test('marks the native input as a peer so an adjacent disabled Label still dims', () => {
    render(<Switch aria-label="Disabled" checked={false} disabled onCheckedChange={() => undefined} />);

    expect(screen.getByLabelText('Disabled')).toHaveClass('peer');
  });
});
