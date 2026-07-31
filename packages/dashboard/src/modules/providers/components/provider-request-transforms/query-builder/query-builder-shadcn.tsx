import React from 'react';
import type { QueryBuilderContextProviderProps } from 'react-querybuilder';

import { queryBuilderShadcnProvider } from './query-builder-shadcn-provider';

export interface QueryBuilderShadcnProps extends QueryBuilderContextProviderProps {}

export const QueryBuilderShadcn: React.FC<QueryBuilderShadcnProps> = (props) =>
  React.createElement(queryBuilderShadcnProvider, props);
