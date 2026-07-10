import { m } from "@aio-proxy/i18n";
import type { AliasConfig, AliasTarget } from "@aio-proxy/types";
import { omit } from "es-toolkit/object";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ProviderFormMode } from "../constants";
import type { useProviderForm } from "../hooks/use-provider-form";

type ProviderAlias = Record<string, AliasConfig>;

type Props = {
  form: ReturnType<typeof useProviderForm>;
  mode: ProviderFormMode;
};

const normalizeAlias = (value: unknown): ProviderAlias =>
  value && typeof value === "object" ? (value as ProviderAlias) : {};

const emptyConfig = (model: string): AliasConfig => ({ model, preserve: false });

const emptyTarget = (model: string): AliasTarget => ({ model, preserve: false });

const renameKey = <T,>(record: Record<string, T>, from: string, to: string): Record<string, T> => {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    next[key === from ? to : key] = value;
  }
  return next;
};

export const ProviderAliasFields: React.FC<Props> = ({ form, mode }) => {
  return (
    <form.Subscribe selector={(state) => state.values.models ?? []}>
      {(models) => (
        <div data-testid="provider-form-field-alias">
          <form.Field name="alias">
            {(field) => {
              const alias = normalizeAlias(field.state.value);
              const update = (next: ProviderAlias) =>
                field.handleChange(
                  Object.keys(next).length === 0 && mode === ProviderFormMode.Create ? undefined : next,
                );

              return (
                <Field>
                  <div className="space-y-1">
                    <Label>{m["dashboard.providers.form.label_aliases"]()}</Label>
                  </div>
                  {models.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      {m["dashboard.providers.form.aliases_empty_models"]()}
                    </p>
                  ) : (
                    <div className="space-y-3 rounded-3xl border border-border bg-muted/20 p-3">
                      {Object.keys(alias).length === 0 && (
                        <p className="text-muted-foreground text-sm">{m["dashboard.providers.form.aliases_empty"]()}</p>
                      )}
                      {Object.entries(alias).map(([aliasName, config]) => {
                        const variants = config.variants ?? {};
                        return (
                          <div key={aliasName} className="space-y-3 rounded-2xl border border-border bg-background p-3">
                            <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto_auto]">
                              <Input
                                value={aliasName}
                                onChange={(event) => update(renameKey(alias, aliasName, event.target.value))}
                                placeholder={m["dashboard.providers.form.alias_name"]()}
                                aria-label={m["dashboard.providers.form.alias_name"]()}
                              />
                              <Select
                                value={config.model}
                                onValueChange={(model) => {
                                  if (model !== null) update({ ...alias, [aliasName]: { ...config, model } });
                                }}
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue placeholder={m["dashboard.providers.form.alias_target"]()} />
                                </SelectTrigger>
                                <SelectContent>
                                  {models.map((model) => (
                                    <SelectItem key={model} value={model}>
                                      {model}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <div className="flex items-center gap-2 text-sm">
                                <Switch
                                  checked={config.preserve}
                                  onCheckedChange={(preserve) =>
                                    update({ ...alias, [aliasName]: { ...config, preserve: Boolean(preserve) } })
                                  }
                                />
                                {m["dashboard.providers.form.alias_preserve"]()}
                              </div>
                              <Button type="button" variant="outline" onClick={() => update(omit(alias, [aliasName]))}>
                                {m["dashboard.providers.form.remove_alias"]()}
                              </Button>
                            </div>
                            <div className="space-y-2 border-border border-t pt-3">
                              <p className="text-muted-foreground text-sm">
                                {m["dashboard.providers.form.label_variants"]()}
                              </p>
                              {Object.entries(variants).map(([variantName, target]) => (
                                <div key={variantName} className="grid gap-2 md:grid-cols-[1fr_1fr_auto_auto]">
                                  <Input
                                    value={variantName}
                                    onChange={(event) => {
                                      const nextVariants = renameKey(variants, variantName, event.target.value);
                                      update({ ...alias, [aliasName]: { ...config, variants: nextVariants } });
                                    }}
                                    placeholder={m["dashboard.providers.form.variant_name"]()}
                                    aria-label={m["dashboard.providers.form.variant_name"]()}
                                  />
                                  <Select
                                    value={target.model}
                                    onValueChange={(model) => {
                                      if (model === null) return;
                                      update({
                                        ...alias,
                                        [aliasName]: {
                                          ...config,
                                          variants: { ...variants, [variantName]: { ...target, model } },
                                        },
                                      });
                                    }}
                                  >
                                    <SelectTrigger className="w-full">
                                      <SelectValue placeholder={m["dashboard.providers.form.variant_target"]()} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {models.map((model) => (
                                        <SelectItem key={model} value={model}>
                                          {model}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  <div className="flex items-center gap-2 text-sm">
                                    <Switch
                                      checked={target.preserve}
                                      onCheckedChange={(preserve) =>
                                        update({
                                          ...alias,
                                          [aliasName]: {
                                            ...config,
                                            variants: {
                                              ...variants,
                                              [variantName]: { ...target, preserve: Boolean(preserve) },
                                            },
                                          },
                                        })
                                      }
                                    />
                                    {m["dashboard.providers.form.variant_preserve"]()}
                                  </div>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() =>
                                      update({
                                        ...alias,
                                        [aliasName]: { ...config, variants: omit(variants, [variantName]) },
                                      })
                                    }
                                  >
                                    {m["dashboard.providers.form.remove_variant"]()}
                                  </Button>
                                </div>
                              ))}
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => {
                                  const model = models[0];
                                  if (model === undefined) return;
                                  const nextName = `variant-${Object.keys(variants).length + 1}`;
                                  update({
                                    ...alias,
                                    [aliasName]: {
                                      ...config,
                                      variants: { ...variants, [nextName]: emptyTarget(model) },
                                    },
                                  });
                                }}
                              >
                                {m["dashboard.providers.form.add_variant"]()}
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          const model = models[0];
                          if (model === undefined) return;
                          const nextName = `alias-${Object.keys(alias).length + 1}`;
                          update({ ...alias, [nextName]: emptyConfig(model) });
                        }}
                      >
                        {m["dashboard.providers.form.add_alias"]()}
                      </Button>
                    </div>
                  )}
                </Field>
              );
            }}
          </form.Field>
        </div>
      )}
    </form.Subscribe>
  );
};
