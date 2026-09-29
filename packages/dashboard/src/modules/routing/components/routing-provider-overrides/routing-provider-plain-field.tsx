import { Label } from '@aio-proxy/ui/components/label';
import type React from 'react';

import { ModelMetadataNumberField } from '../model-metadata-visual-tab/model-metadata-number-field';

interface RoutingProviderPlainFieldProps {
  readonly id: string;
  readonly label: string;
  readonly unit?: string;
  readonly min: number;
  readonly step: number | 'any';
  /** What an empty field means for this Provider: not charged, or no limit. */
  readonly placeholder: string;
  readonly value: number | undefined;
  readonly onValueChange: (next: number | undefined) => void;
}

/** One number of a Provider's own price list or limits, label beside the input. */
export const RoutingProviderPlainField: React.FC<RoutingProviderPlainFieldProps> = ({ id, label, unit, ...field }) => (
  <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
    <Label htmlFor={id} className="font-normal text-muted-foreground">
      {label}
    </Label>
    <ModelMetadataNumberField id={id} label={label} labelHidden unit={unit} {...field} />
  </div>
);
