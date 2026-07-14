import {
  type ConfigSpec,
  definePlugin,
  isPluginDescriptor,
  type PluginDescriptor,
  type PluginDescriptorShell,
} from "../src";

type MyOptions = {
  readonly baseURL: string;
};

const typedDescriptor = definePlugin<MyOptions>((_api, options) => {
  options.baseURL;
});

const fullDescriptor: PluginDescriptor<MyOptions> = typedDescriptor;
const descriptorShell: PluginDescriptorShell = typedDescriptor;
void fullDescriptor;
void descriptorShell;

declare const candidate: unknown;

if (isPluginDescriptor(candidate)) {
  const opaqueOptions: unknown = candidate.metadata.options;
  const opaqueSetup: unknown = candidate.setup;
  void opaqueOptions;
  void opaqueSetup;

  // @ts-expect-error Runtime identification does not validate a ConfigSpec.
  const configSpec: ConfigSpec<unknown> = candidate.metadata.options;
  // @ts-expect-error Runtime identification does not establish a full descriptor contract.
  const pluginDescriptor: PluginDescriptor<unknown> = candidate;
  void configSpec;
  void pluginDescriptor;
}
