import { m } from '@aio-proxy/i18n';
import { Slider } from '@aio-proxy/ui/components/slider';
import type React from 'react';

interface ProviderCardRoutingControlProps {
  readonly providerId: string;
  readonly share: number;
  readonly disabled: boolean;
  readonly onChange: (share: number) => void;
}

export const ProviderCardRoutingControl: React.FC<ProviderCardRoutingControlProps> = ({
  providerId,
  share,
  disabled,
  onChange,
}) => (
  <div
    className="relative z-10 space-y-2 rounded-lg bg-muted/60 p-3"
    data-testid={`provider-share-control-${providerId}`}
  >
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{m['dashboard.providers.routing.share']()}</span>
      <strong className="font-heading text-sm" data-testid={`provider-share-${providerId}`}>
        {share}%
      </strong>
    </div>
    <Slider
      aria-label={m['dashboard.providers.routing.share_aria']({ providerId })}
      data-testid={`provider-share-slider-${providerId}`}
      min={1}
      max={100}
      step={1}
      disabled={disabled}
      value={[share]}
      onValueChange={(value) => {
        const next = Array.isArray(value) ? value[0] : value;
        if (typeof next === 'number') onChange(next);
      }}
    />
  </div>
);
