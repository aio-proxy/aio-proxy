import { createFileRoute } from "@tanstack/react-router";

import { ProvidersPage } from "@/modules/providers/templates/providers-page";

export const Route = createFileRoute("/providers/")({ component: ProvidersPage });
