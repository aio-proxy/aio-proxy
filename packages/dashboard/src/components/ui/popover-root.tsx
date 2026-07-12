import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

export const Popover: React.FC<PopoverPrimitive.Root.Props> = (props) => (
  <PopoverPrimitive.Root data-slot="popover" {...props} />
);
