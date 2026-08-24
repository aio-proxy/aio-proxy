import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Input } from '@aio-proxy/ui/components/input';
import { useState } from 'react';

import { parseManualModelIds } from '../../../lib/add-manual-models';

interface ModelsManualAddProps {
  readonly onAdd: (ids: readonly string[]) => void;
}

export const ModelsManualAdd: React.FC<ModelsManualAddProps> = ({ onAdd }) => {
  const [manual, setManual] = useState('');

  const submit = () => {
    const ids = parseManualModelIds(manual);
    if (ids.length === 0) return;
    onAdd(ids);
    setManual('');
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Input
        value={manual}
        placeholder={m['dashboard.providers.editor.models_manual_add']()}
        aria-label={m['dashboard.providers.editor.models_manual_add']()}
        className="w-full font-mono sm:w-64"
        onChange={(event) => setManual(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          submit();
        }}
      />
      <Button type="button" variant="outline" size="sm" onClick={submit}>
        {m['dashboard.providers.form.models_manual_submit']()}
      </Button>
    </div>
  );
};
