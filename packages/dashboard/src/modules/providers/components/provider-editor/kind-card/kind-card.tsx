import { m } from '@aio-proxy/i18n';
import type { ProviderKind } from '@aio-proxy/types';
import { Card, CardContent, CardHeader } from '@aio-proxy/ui/components/card';

import { ProviderFormMode } from '../../../lib/constants';
import { KindPicker } from './kind-picker';

const HEADING_ID = 'provider-kind-heading';

interface KindCardProps {
  readonly value: ProviderKind;
  readonly mode: ProviderFormMode;
  readonly onChange: (kind: ProviderKind) => void;
}

/**
 * Its own card above Identity, not a field inside it: the kind decides which connection fields exist at
 * all, so it is the form's shape rather than one of its attributes. The demo folds it into the identity
 * section; the user's ruling overrides that (fidelity-rules D-F11).
 *
 * Deliberately outside `SectionShell`: a section carries an anchor, a status dot and a nav pill, and the
 * kind is never `todo` — it always holds one of three values — so a permanent `ok` dot would be noise in
 * a strip whose whole job is showing what still needs attention.
 */
export const KindCard: React.FC<KindCardProps> = ({ value, mode, onChange }) => (
  <Card>
    <CardHeader>
      {/* `<h2>` to sit at the same outline level as the section headings below it, and the group's
          accessible name by reference — the picker used to repeat this label as its own `aria-label`,
          which a screen reader read out twice. */}
      <h2 id={HEADING_ID} className="font-heading text-base font-medium">
        {m['dashboard.providers.editor.kind_label']()}
      </h2>
      {/* Create only: it says what the choice governs, which is meaningless beside a settled kind that
          cannot be chosen again. `data-slot` is what gives it its own row in `CardHeader`'s grid. */}
      {mode === ProviderFormMode.Create ? (
        <p data-slot="card-description" className="max-w-prose text-sm text-muted-foreground">
          {m['dashboard.providers.editor.kind_description']()}
        </p>
      ) : null}
    </CardHeader>
    <CardContent>
      <KindPicker value={value} onChange={onChange} locked={mode === ProviderFormMode.Edit} labelledBy={HEADING_ID} />
    </CardContent>
  </Card>
);
