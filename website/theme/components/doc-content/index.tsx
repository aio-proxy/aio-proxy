import { DocContent as BasicDocContent } from '@rspress/core/theme-original';

type DocContentProps = React.ComponentProps<typeof BasicDocContent>;

export const DocContent: React.FC<DocContentProps> = (props) => (
  <div className="typeset">
    <BasicDocContent {...props} />
  </div>
);
