import { Button } from '@aio-proxy/ui/components/button';
import type React from 'react';
import type { ActionProps } from 'react-querybuilder';

export interface QueryBuilderActionElementProps extends ActionProps {}

export const QueryBuilderActionElement: React.FC<QueryBuilderActionElementProps> = (allProps) => {
  const {
    className,
    label,
    title,
    disabled,
    disabledTranslation,
    testID,
    rules: _rules,
    ruleOrGroup: _ruleOrGroup,
    path: _path,
    level: _level,
    context: _context,
    validation: _validation,
    schema: _schema,
  } = allProps;
  const resolvedTitle = disabledTranslation && disabled ? disabledTranslation.title : title;
  return (
    <Button
      data-testid={testID}
      type="button"
      variant="outline"
      size="sm"
      className={className}
      title={resolvedTitle}
      aria-label={resolvedTitle}
      disabled={disabled && !disabledTranslation}
      onClick={(event) => allProps.handleOnClick(event)}
    >
      {disabledTranslation && disabled ? disabledTranslation.label : label}
    </Button>
  );
};
