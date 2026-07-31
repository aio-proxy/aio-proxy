import { useId } from 'react';
import type React from 'react';
import type { NotToggleProps } from 'react-querybuilder';

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

export interface QueryBuilderNotToggleProps extends NotToggleProps {}

export const QueryBuilderNotToggle: React.FC<QueryBuilderNotToggleProps> = (allProps) => {
  const {
    className,
    label,
    checked,
    title,
    disabled,
    testID,
    path: _path,
    level: _level,
    context: _context,
    validation: _validation,
    schema: _schema,
    ruleGroup: _ruleGroup,
  } = allProps;
  const id = useId();
  return (
    <span className="inline-flex items-center gap-2">
      <Switch
        id={id}
        data-testid={testID}
        className={className}
        title={title}
        aria-label={title}
        checked={!!checked}
        disabled={disabled}
        onCheckedChange={(nextChecked) => allProps.handleOnChange(nextChecked)}
      />
      <Label htmlFor={id}>{label}</Label>
    </span>
  );
};
