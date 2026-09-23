import { m } from '@aio-proxy/i18n';
import type { DashboardSettingsView } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { useState } from 'react';

import type { SettingsSave } from '../settings-form/settings-form-contract';
import { SettingsOtelDialog } from './settings-otel-dialog';

const DESTINATION_CAP = 8;

interface SettingsOtelGroupProps {
  readonly disabled: boolean;
  readonly settings: DashboardSettingsView;
  readonly onSave: SettingsSave;
}

export const SettingsOtelGroup: React.FC<SettingsOtelGroupProps> = ({ disabled, settings, onSave }) => {
  const [open, setOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | undefined>();
  const [session, setSession] = useState(0);
  const destinations = settings.otel.destinations;
  const atCap = destinations.length >= DESTINATION_CAP;
  const openDialog = (index: number | undefined) => {
    setEditingIndex(index);
    setSession((current) => current + 1);
    setOpen(true);
  };

  return (
    <Card data-testid="settings-group-otel">
      <CardHeader>
        <CardTitle>
          <h2>{m['dashboard.settings.otel_group']()}</h2>
        </CardTitle>
        <CardAction>
          <Button type="button" size="sm" disabled={disabled || atCap} onClick={() => openDialog(undefined)}>
            {m['dashboard.settings.otel_add']()}
          </Button>
        </CardAction>
        <CardDescription>{m['dashboard.settings.otel_description']()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {destinations.map((destination, index) => (
          <div key={`${destination.url}-${index}`} className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-sm">{destination.url}</span>
              <Badge variant="outline">{destination.contentType === 'protobuf' ? 'Protobuf' : 'JSON'}</Badge>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => openDialog(index)}>
                {m['dashboard.settings.otel_edit']()}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  onSave({
                    otel: { destinations: destinations.filter((_, destinationIndex) => destinationIndex !== index) },
                  });
                }}
              >
                {m['dashboard.settings.otel_delete']()}
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
      <SettingsOtelDialog
        key={session}
        open={open}
        disabled={disabled}
        editingIndex={editingIndex}
        destinations={destinations}
        onOpenChange={setOpen}
        onSave={onSave}
      />
    </Card>
  );
};
