import { Button } from '@aio-proxy/ui/components/button';
import type React from 'react';
import type { ShiftActionsProps } from 'react-querybuilder';

export interface QueryBuilderShiftActionsProps extends ShiftActionsProps {}

export const QueryBuilderShiftActions: React.FC<QueryBuilderShiftActionsProps> = ({
  shiftUp,
  shiftDown,
  shiftUpDisabled,
  shiftDownDisabled,
  disabled,
  className,
  labels,
  titles,
  testID,
  path: _path,
  level: _level,
  context: _context,
  validation: _validation,
  schema: _schema,
  ruleOrGroup: _ruleOrGroup,
}) => (
  <span data-testid={testID} className={className}>
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled || shiftUpDisabled}
      onClick={shiftUp}
      title={titles?.shiftUp}
      aria-label={titles?.shiftUp}
    >
      {labels?.shiftUp}
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled || shiftDownDisabled}
      onClick={shiftDown}
      title={titles?.shiftDown}
      aria-label={titles?.shiftDown}
    >
      {labels?.shiftDown}
    </Button>
  </span>
);
