import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import NumberFlow, { type Format } from '@number-flow/react';

interface KpiNumberProps {
  readonly value: number | string;
  readonly format: Format;
  readonly locales: string;
  /** Exact value revealed on hover when `format` rounds or abbreviates the number. */
  readonly tooltip?: string;
}

export const KpiNumber: React.FC<KpiNumberProps> = ({ value, format, locales, tooltip }) => {
  // Client-rendered NumberFlow puts every digit in shadow DOM, so expose the formatted
  // value as a single label the way number-flow's own SSR output does.
  const label = (new Intl.NumberFormat(locales, format).format as unknown as (value: number | string) => string)(value);
  const number = <NumberFlow value={value} format={format} locales={locales} role="img" aria-label={label} />;

  if (tooltip === undefined) return number;

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="w-fit" />}>{number}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
};
