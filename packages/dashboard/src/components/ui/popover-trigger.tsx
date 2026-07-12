import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

export const PopoverTrigger: React.FC<PopoverPrimitive.Trigger.Props> = (props) => (
  <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
);
