import { expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { TopModelRanking } from './top-model-ranking';

const costs = [
  { modelId: 'cost-leader', estimatedCostNanoUsd: 1_500_000_000n },
  { modelId: 'cost-runner', estimatedCostNanoUsd: 1_000_000_000n },
];
const tokens = [
  { modelId: 'token-leader', totalTokens: 8_192n },
  { modelId: 'token-runner', totalTokens: 4_096n },
];

test('ranks models by cost first and switches to an independent Token ranking', () => {
  render(<TopModelRanking costs={costs} tokens={tokens} />);

  expect(screen.getByRole('heading', { name: /Model ranking|模型排行/u })).toBeInTheDocument();
  expect(screen.getByText('cost-leader')).toBeInTheDocument();
  expect(screen.getByText('cost-runner')).toBeInTheDocument();
  expect(screen.queryByText('token-leader')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /^Token$/u }));

  expect(screen.getByText('token-leader')).toBeInTheDocument();
  expect(screen.getByText('token-runner')).toBeInTheDocument();
  expect(screen.getByText('8,192')).toBeInTheDocument();
  expect(screen.queryByText('cost-leader')).not.toBeInTheDocument();
});

test('keeps the empty state specific to the selected ranking metric', () => {
  render(<TopModelRanking costs={[]} tokens={tokens} />);

  expect(screen.getByText(/No model costs recorded|暂无已记录的模型费用/u)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: /^Token$/u }));
  expect(screen.getByText('token-leader')).toBeInTheDocument();
});
