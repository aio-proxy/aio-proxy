import { createFileRoute } from '@tanstack/react-router';

import { SettingsPage } from '@/modules/settings/templates/settings-page';

export const Route = createFileRoute('/settings/')({ component: SettingsPage });
