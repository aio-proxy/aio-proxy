'use client';

import { CodeBlockRuntime, Tab, Tabs } from '@rspress/core/theme';

import { BunIcon, HomebrewIcon } from '../icons';

interface CommandTabsProps {
  readonly commands: Partial<Record<CommandId, string>>;
}

const commandIcon = {
  bun: BunIcon,
  brew: HomebrewIcon,
} as const;

type CommandId = keyof typeof commandIcon;

export const CommandTabs: React.FC<CommandTabsProps> = ({ commands }) => {
  const entries = Object.entries(commands) as [CommandId, string][];

  return (
    <Tabs groupId="command-tabs">
      {entries.map(([key, command]) => {
        const Icon = commandIcon[key];
        return (
          <Tab
            key={key}
            label={
              <div className="flex items-center gap-2">
                <Icon className="h-4 inline-flex" aria-hidden />
                {key}
              </div>
            }
          >
            <CodeBlockRuntime lang="bash" code={command} />
          </Tab>
        );
      })}
    </Tabs>
  );
};
