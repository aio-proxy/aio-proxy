import {
  type ConfigSpec,
  definePlugin,
  isPluginDescriptor,
  type PluginDescriptor,
  type PluginDescriptorShell,
} from '..';

type MyOptions = {
  readonly baseURL: string;
};

const typedDescriptor = definePlugin<MyOptions>(
  (_api, options) => {
    void options.baseURL;
  },
  {
    displayName: { default: 'Example plugin', 'zh-Hans': '示例插件' },
    description: 'Example description',
    icon: 'openai',
  },
);

const fullDescriptor: PluginDescriptor<MyOptions> = typedDescriptor;
const descriptorShell: PluginDescriptorShell = typedDescriptor;
void fullDescriptor;
void descriptorShell;

const staleAuthoredDescriptor: PluginDescriptor<MyOptions> = {
  ...typedDescriptor,
  // @ts-expect-error Authored descriptors must advertise the current API version.
  apiVersion: 1,
};
void staleAuthoredDescriptor;

declare const candidate: unknown;

if (isPluginDescriptor(candidate)) {
  const opaqueOptions: unknown = candidate.metadata.options;
  const localizedDisplayName = candidate.metadata.displayName;
  const localizedDescription = candidate.metadata.description;
  const opaqueIcon: unknown = candidate.metadata.icon;
  const opaqueSetup: unknown = candidate.setup;
  void opaqueOptions;
  void localizedDisplayName;
  void localizedDescription;
  void opaqueIcon;
  void opaqueSetup;

  // @ts-expect-error Runtime identification does not validate a ConfigSpec.
  const configSpec: ConfigSpec<unknown> = candidate.metadata.options;
  // @ts-expect-error Runtime identification does not establish a full descriptor contract.
  const pluginDescriptor: PluginDescriptor<unknown> = candidate;
  void configSpec;
  void pluginDescriptor;
}
