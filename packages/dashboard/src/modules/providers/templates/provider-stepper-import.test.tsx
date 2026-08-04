import { Stepper, StepperItem, StepperTrigger } from '@aio-proxy/ui/components/reui/stepper';
import { expect, test } from '@rstest/core';

test('resolves the shared stepper components', () => {
  expect(Stepper).toBeTypeOf('function');
  expect(StepperItem).toBeTypeOf('function');
  expect(StepperTrigger).toBeTypeOf('function');
});
