import { createFileRoute } from '@tanstack/react-router';

import { OAuthCompletePage } from '@/modules/oauth-complete/templates/oauth-complete-page';

export const Route = createFileRoute('/oauth/complete')({ component: OAuthCompletePage });
