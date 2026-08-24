import { m } from '@aio-proxy/i18n';
import type { ProviderEndpointAuth, ProviderProtocol } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldDescription } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Switch } from '@aio-proxy/ui/components/switch';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';

import { PROTOCOL_ORDER, ProtocolLabel } from '@/components/protocol-label';

import type { ProviderEditorForm } from '../hooks/use-provider-editor-form';
import {
  emptySharedDraft,
  sharedConversionIssue,
  switchApiEndpointShape,
  type ApiEndpointDraft,
} from '../lib/api-endpoints';

interface ProviderFormFieldsApiProps {
  form: ProviderEditorForm;
  /**
   * Whether this provider already has a stored API key. Not `mode`: a key is optional for most
   * upstreams, so an edit with no stored key must not promise to retain one, and a create seeded
   * from an existing entry (kind switch) must not claim the field is empty.
   */
  hasApiKey: boolean;
}

const draftOf = (value: unknown): ApiEndpointDraft =>
  value !== undefined && typeof value === 'object' && value !== null && 'shape' in value
    ? (value as ApiEndpointDraft)
    : emptySharedDraft();

export const ProviderFormFieldsApi: React.FC<ProviderFormFieldsApiProps> = ({ form, hasApiKey }) => {
  const [conversionNotice, setConversionNotice] = useState(false);
  return (
    <>
      <form.Field name="endpoints">
        {(field) => {
          const draft = draftOf(field.state.value);
          const setDraft = (next: ApiEndpointDraft) => field.handleChange(next);
          return (
            <div className="space-y-4" data-testid="provider-form-field-endpoints">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium">{m['dashboard.providers.form.endpoints_title']()}</h3>
                  <p className="text-xs text-muted-foreground">
                    {m['dashboard.providers.form.endpoints_shared_help']()}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    size="sm"
                    checked={draft.shape === 'separate'}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setConversionNotice(false);
                        setDraft(switchApiEndpointShape(draft, 'separate'));
                        return;
                      }
                      if (draft.shape === 'separate' && sharedConversionIssue(draft.entries) !== undefined) {
                        setConversionNotice(true);
                        return;
                      }
                      setConversionNotice(false);
                      setDraft(switchApiEndpointShape(draft, 'shared'));
                    }}
                  />
                  {m['dashboard.providers.form.endpoints_independent']()}
                </label>
              </div>
              {conversionNotice ? (
                <p role="status" className="text-xs text-destructive">
                  {m['dashboard.providers.form.endpoints_shared_conversion_blocked']()}
                </p>
              ) : null}
              {draft.shape === 'shared' ? (
                <div className="space-y-3">
                  <div data-testid="provider-form-field-protocol">
                    <Field>
                      <Label>{m['dashboard.providers.form.label_protocol']()}</Label>
                      <Select
                        multiple
                        value={[...draft.protocols]}
                        onValueChange={(protocols) =>
                          setDraft({ ...draft, protocols: protocols as ProviderProtocol[] })
                        }
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label={m['dashboard.providers.form.placeholder_protocol']()}
                        >
                          <SelectValue>
                            {(selected: ProviderProtocol[]) =>
                              selected.length === 0 ? (
                                m['dashboard.providers.form.placeholder_protocol']()
                              ) : (
                                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                  {selected.map((protocol) => (
                                    <ProtocolLabel key={protocol} protocol={protocol} showIcon />
                                  ))}
                                </span>
                              )
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {PROTOCOL_ORDER.map((protocol) => (
                            <SelectItem key={protocol} value={protocol}>
                              <ProtocolLabel protocol={protocol} showIcon />
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <div data-testid="provider-form-field-baseURL">
                    <Field>
                      <Label htmlFor="provider-shared-base-url">{m['dashboard.providers.form.label_base_url']()}</Label>
                      <Input
                        id="provider-shared-base-url"
                        value={draft.baseURL}
                        onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })}
                        placeholder={m['dashboard.providers.form.placeholder_base_url']()}
                      />
                    </Field>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {draft.entries.map((entry, index) => (
                    <div
                      key={`${entry.protocol}-${index}`}
                      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl bg-muted/40 px-3 py-2 ${entry.protocol === 'anthropic' ? 'sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,9rem)_auto]' : 'sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]'}`}
                    >
                      <Select
                        value={entry.protocol === '' ? null : entry.protocol}
                        onValueChange={(protocol) =>
                          setDraft({
                            ...draft,
                            entries: draft.entries.map((row, rowIndex) =>
                              rowIndex === index
                                ? {
                                    ...row,
                                    protocol: (protocol ?? '') as ProviderProtocol | '',
                                    ...(protocol === 'anthropic' ? {} : { auth: undefined }),
                                  }
                                : row,
                            ),
                          })
                        }
                      >
                        <SelectTrigger
                          className="col-start-1 row-start-1 w-full"
                          aria-label={m['dashboard.providers.form.label_protocol']()}
                        >
                          <SelectValue placeholder={m['dashboard.providers.form.placeholder_protocol']()}>
                            {(protocol: ProviderProtocol | null) =>
                              protocol ? (
                                <ProtocolLabel protocol={protocol} showIcon />
                              ) : (
                                m['dashboard.providers.form.placeholder_protocol']()
                              )
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {PROTOCOL_ORDER.map((protocol) => (
                            <SelectItem key={protocol} value={protocol}>
                              <ProtocolLabel protocol={protocol} showIcon />
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        aria-label={m['dashboard.providers.form.label_base_url']()}
                        value={entry.baseURL}
                        placeholder={m['dashboard.providers.form.placeholder_base_url']()}
                        className="col-span-2 font-mono sm:col-span-1"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            entries: draft.entries.map((row, rowIndex) =>
                              rowIndex === index ? { ...row, baseURL: event.target.value } : row,
                            ),
                          })
                        }
                      />
                      {entry.protocol === 'anthropic' ? (
                        <Select
                          value={entry.auth ?? 'x-api-key'}
                          onValueChange={(auth) =>
                            setDraft({
                              ...draft,
                              entries: draft.entries.map((row, rowIndex) =>
                                rowIndex === index
                                  ? { ...row, auth: (auth ?? 'x-api-key') as ProviderEndpointAuth }
                                  : row,
                              ),
                            })
                          }
                        >
                          <SelectTrigger
                            className="col-span-2 w-full sm:col-span-1"
                            aria-label={m['dashboard.providers.form.endpoints_anthropic_auth']()}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="x-api-key">x-api-key</SelectItem>
                            <SelectItem value="bearer">Bearer</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="col-start-2 row-start-1 sm:col-start-auto sm:row-start-auto"
                        aria-label={m['dashboard.providers.form.endpoints_remove']()}
                        onClick={() => {
                          const entries = draft.entries.filter((_, rowIndex) => rowIndex !== index);
                          setDraft({
                            shape: 'separate',
                            entries: entries.length === 0 ? [{ protocol: '', baseURL: '' }] : entries,
                          });
                        }}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDraft({ ...draft, entries: [...draft.entries, { protocol: '', baseURL: '' }] })}
                  >
                    <PlusIcon data-icon="inline-start" />
                    {m['dashboard.providers.form.endpoints_add']()}
                  </Button>
                </div>
              )}
            </div>
          );
        }}
      </form.Field>
      <div data-testid="provider-form-field-apiKey">
        <form.Field name="apiKey">
          {(field) => (
            <Field className="border-t pt-4">
              <Label htmlFor={field.name}>{m['dashboard.providers.form.label_api_key']()}</Label>
              <Input
                id={field.name}
                type="password"
                value={field.state.value ?? ''}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder={
                  hasApiKey
                    ? m['dashboard.providers.form.placeholder_api_key_configured']()
                    : m['dashboard.providers.form.placeholder_api_key']()
                }
              />
              <FieldDescription>
                {hasApiKey
                  ? m['dashboard.providers.editor.api_key_retained_hint']()
                  : m['dashboard.providers.form.api_key_helper_create']()}
              </FieldDescription>
            </Field>
          )}
        </form.Field>
      </div>
    </>
  );
};
