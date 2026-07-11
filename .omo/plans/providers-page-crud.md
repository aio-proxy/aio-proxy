# providers-page-crud - Work Plan

## TL;DR (For humans)

Full-stack provider CRUD dashboard. See draft for details.

## Todos

- [x] 1. Promote `name` to SharedProviderSchemaBase and extend DashboardProviderSummarySchema
- [x] 2. Add i18n keys for providers pages and compile
- [x] 3. Add required shadcn primitives via CLI
- [x] 4. Create atomic config-store module and expose configPath on ServerState
- [x] 5. Add ProviderMutationBodySchema (discriminated, apiKey semantics)
- [x] 6. Wire dashboard mutation routes (POST/PUT/DELETE) + edit-view GET
- [x] 7. Extend provider-runtime summary derivation
- [x] 8. Server integration test for dashboard provider CRUD
- [x] 9. Full server build + biome gate
- [x] 10. Mount QueryClientProvider in RootLayout
- [x] 11. Real QueryClient singleton in packages/dashboard/src/lib/query-client.ts
- [x] 12. Providers services module (query options + mutations)
- [x] 13. Providers hooks (useProviderForm, useProvidersTable, useProviderMutations)
- [x] 14. Components: provider-kind-badge + provider-actions-menu
- [x] 15. Component: provider-form-fields-api
- [x] 16. Component: provider-form-fields-ai-sdk
- [x] 17. Component: delete-provider-dialog
- [x] 18. Template + route: providers list page
- [x] 19. Template + routes: provider form page (new + edit) + placeholder aliases route
- [x] 20. Final i18n compile + workspace build + biome + turbo test

## Final verification wave

- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Agent-executed HTTP + browser smoke
- [x] F4. Scope fidelity
