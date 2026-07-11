import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Props = { models: readonly string[] };

export const ProviderModelsCell: React.FC<Props> = ({ models }) => {
  if (models.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="secondary" data-testid="provider-models-count" />}>
        {models.length}
      </TooltipTrigger>
      <TooltipContent>
        <ul className="flex flex-col gap-0.5">
          {models.map((model) => (
            <li key={model}>{model}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
};
