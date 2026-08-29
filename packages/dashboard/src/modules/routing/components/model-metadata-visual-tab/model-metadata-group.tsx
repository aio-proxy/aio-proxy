import { cn } from '@aio-proxy/ui/lib/utils';

interface ModelMetadataGroupProps {
  readonly titleId: string;
  readonly title: string;
  readonly hint: string;
  /** The first two groups sit flush with the top of the tab; the rest carry a rule above them. */
  readonly separated?: boolean;
  readonly children: React.ReactNode;
}

/** One labelled group of metadata overrides: heading, hint, and the controls it explains. */
export const ModelMetadataGroup: React.FC<ModelMetadataGroupProps> = ({
  titleId,
  title,
  hint,
  separated = true,
  children,
}) => (
  <section className={cn('space-y-3', separated ? 'border-t pt-5' : '')} aria-labelledby={titleId}>
    <div>
      <h3 id={titleId} className="text-sm font-medium">
        {title}
      </h3>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
    {children}
  </section>
);
