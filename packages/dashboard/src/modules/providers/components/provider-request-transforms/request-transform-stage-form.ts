import { useForm } from '@tanstack/react-form';

import type { RequestTransformStageDraft } from '../../lib/request-transforms';
import { requestTransformStageControlValues } from './request-transform-stage-draft';

export const useRequestTransformStageForm = (stage: RequestTransformStageDraft) =>
  useForm({ defaultValues: requestTransformStageControlValues(stage) });

export type RequestTransformStageForm = ReturnType<typeof useRequestTransformStageForm>;
