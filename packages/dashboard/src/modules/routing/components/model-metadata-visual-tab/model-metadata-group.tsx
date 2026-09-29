interface ModelMetadataGroupProps {
  readonly titleId: string;
  readonly title: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}

/** One labelled group of the drawer: heading, an optional hint, and the controls it explains. */
export const ModelMetadataGroup: React.FC<ModelMetadataGroupProps> = ({ titleId, title, hint, children }) => (
  <section className="space-y-2" aria-labelledby={titleId}>
    <div className="space-y-0.5">
      {/* Focusable so the drawer can land on the group whose card opened it. */}
      <h3 id={titleId} tabIndex={-1} className="scroll-mt-4 font-heading text-sm font-medium outline-none">
        {title}
      </h3>
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
    {children}
  </section>
);
