import { m } from '@aio-proxy/i18n';
import { ProviderKind, type ProviderTransforms } from '@aio-proxy/types';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@aio-proxy/ui/components/accordion';
import { FieldDescription } from '@aio-proxy/ui/components/field';

import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { headerCountText, proxyModeLabel, transformRuleCountText } from '../../../lib/advanced-summary';
import type { SectionSummary } from '../../../lib/section-status';
import { ProviderHeadersField } from '../../provider-headers-field';
import { ProviderProxyField } from '../../provider-proxy-field';
import { ProviderRequestTransformsFormField } from '../../provider-request-transforms/provider-request-transforms-form-field';
import { SectionShell } from '../section-shell';

interface AdvancedSectionProps {
  readonly form: ProviderEditorForm;
  readonly kind: ProviderKind;
  readonly summary: SectionSummary;
  readonly onTransformsValidityChange: (valid: boolean) => void;
}

export const AdvancedSection: React.FC<AdvancedSectionProps> = ({
  form,
  kind,
  summary,
  onTransformsValidityChange,
}) => (
  <SectionShell
    id="advanced"
    title={m['dashboard.providers.editor.section_advanced']()}
    description={m['dashboard.providers.editor.section_advanced_description']()}
    status={summary.status}
    statusHint={summary.hint}
  >
    <Accordion multiple>
      <AccordionItem value="proxy">
        <AccordionTrigger>
          <span>{m['dashboard.providers.editor.advanced_group_network']()}</span>
          <form.Subscribe
            selector={(state) =>
              [state.values.proxy, 'headers' in state.values ? state.values.headers : undefined] as const
            }
          >
            {([proxy, headers]) => {
              const count = kind === ProviderKind.Api ? Object.keys(headers ?? {}).length : 0;
              return (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {proxyModeLabel(proxy)}
                  {count > 0 ? ` · ${headerCountText(count)}` : ''}
                </span>
              );
            }}
          </form.Subscribe>
        </AccordionTrigger>
        <AccordionContent className="space-y-4">
          <form.Field name="proxy">{(field) => <ProviderProxyField field={field} />}</form.Field>
          {kind === ProviderKind.Api ? (
            <form.Field name="headers">
              {(field) => (
                <ProviderHeadersField
                  value={field.state.value as Readonly<Record<string, string>> | undefined}
                  onChange={(headers) => field.handleChange(headers)}
                />
              )}
            </form.Field>
          ) : null}
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="transforms">
        <AccordionTrigger>
          <span>{m['dashboard.providers.editor.advanced_group_transforms']()}</span>
          <form.Subscribe selector={(state) => state.values.transforms}>
            {(transforms) => (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {transformRuleCountText((transforms as ProviderTransforms | undefined)?.request?.length ?? 0)}
              </span>
            )}
          </form.Subscribe>
        </AccordionTrigger>
        <AccordionContent className="space-y-4">
          <FieldDescription>{m['dashboard.providers.transforms.description']()}</FieldDescription>
          <ProviderRequestTransformsFormField form={form} onValidityChange={onTransformsValidityChange} />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </SectionShell>
);
