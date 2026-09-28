import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@aio-proxy/ui/components/collapsible';
import { ChevronRight } from 'lucide-react';
import type React from 'react';

interface ModelMetadataMorePricesProps {
  /** Start open when one of the rarer prices is already set, so a set value is never hidden. */
  readonly defaultOpen: boolean;
  readonly children: React.ReactNode;
}

/** The rarely used prices (audio, image, web search, per request), folded away until asked for. */
export const ModelMetadataMorePrices: React.FC<ModelMetadataMorePricesProps> = ({ defaultOpen, children }) => (
  <Collapsible defaultOpen={defaultOpen}>
    <CollapsibleTrigger
      render={
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="group -ml-2 text-muted-foreground hover:text-foreground"
        />
      }
    >
      <ChevronRight
        data-icon="inline-start"
        className="transition-transform duration-200 group-data-panel-open:rotate-90 motion-reduce:transition-none"
      />
      {m['dashboard.routing.profile.price_more']()}
    </CollapsibleTrigger>
    <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
      <div className="space-y-2 pt-2">{children}</div>
    </CollapsibleContent>
  </Collapsible>
);
