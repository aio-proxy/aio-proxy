import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@aio-proxy/ui/components/drawer';
import { useIsMobile } from '@aio-proxy/ui/hooks/use-mobile';
import { X } from 'lucide-react';
import type React from 'react';

import type { useRoutingMetadataForm } from '../../hooks/use-routing-metadata-form';
import type { MetadataRecord } from '../../lib/model-metadata-fields';
import { RoutingModelDrawerBody, SECTION_ANCHOR, type RoutingModelDrawerSection } from './routing-model-drawer-body';

export type { RoutingModelDrawerSection };

interface RoutingModelDrawerProps {
  readonly open: boolean;
  /** The group to land on when the drawer opens, matching the card whose Edit opened it. */
  readonly section: RoutingModelDrawerSection;
  readonly onOpenChange: (open: boolean) => void;
  readonly metadataForm: ReturnType<typeof useRoutingMetadataForm>;
  readonly model: DashboardRoutingModel;
  readonly writable: boolean;
  readonly setMetadataValid: (valid: boolean) => void;
  /** Invalid metadata text the page keeps, so it survives the drawer closing and reopening. */
  readonly metadataInvalidDraft: string | undefined;
  readonly setMetadataInvalidDraft: (text: string | undefined) => void;
}

/**
 * Model info, prices and per-Provider overrides in one drawer. Edits land in the page's draft,
 * so they are saved together with routing changes from the page's save bar.
 */
export const RoutingModelDrawer: React.FC<RoutingModelDrawerProps> = ({
  open,
  section,
  onOpenChange,
  metadataForm,
  model,
  writable,
  setMetadataValid,
  metadataInvalidDraft,
  setMetadataInvalidDraft,
}) => {
  const isMobile = useIsMobile();
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      // Initial focus lands on the section without scrolling, so it is brought into view once open.
      onOpenChangeComplete={(opened) => {
        if (opened) document.getElementById(SECTION_ANCHOR[section])?.scrollIntoView({ block: 'start' });
      }}
      swipeDirection={isMobile ? 'down' : 'right'}
    >
      <DrawerContent
        className="p-0 sm:w-full sm:max-w-xl"
        data-testid="routing-model-drawer"
        // Focus lands on the group whose card opened the drawer.
        initialFocus={() => document.getElementById(SECTION_ANCHOR[section])}
      >
        <DrawerHeader className="flex-row items-center gap-2 border-b py-3 text-left">
          <DrawerTitle className="flex-1">{m['dashboard.routing.profile.drawer_title']()}</DrawerTitle>
          <DrawerClose
            render={<Button type="button" size="icon-sm" variant="ghost" aria-label={m['common.close']()} />}
          >
            <X />
          </DrawerClose>
        </DrawerHeader>
        <metadataForm.Subscribe selector={(state) => state.values.metadata.value}>
          {(metadata) => (
            <RoutingModelDrawerBody
              metadata={metadata as MetadataRecord | undefined}
              metadataForm={metadataForm}
              model={model}
              writable={writable}
              setMetadataValid={setMetadataValid}
              metadataInvalidDraft={metadataInvalidDraft}
              setMetadataInvalidDraft={setMetadataInvalidDraft}
            />
          )}
        </metadataForm.Subscribe>
        <DrawerFooter className="flex-row items-center justify-end border-t py-3">
          <p className="mr-auto text-xs text-muted-foreground">{m['dashboard.routing.profile.drawer_footer']()}</p>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {m['dashboard.routing.profile.drawer_done']()}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
};
