import { z } from "zod";

const DashboardLocalizedTextValueSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);

export const DashboardLocalizedTextSchema = z.union([
  DashboardLocalizedTextValueSchema,
  z.record(z.string(), DashboardLocalizedTextValueSchema).superRefine((value, context) => {
    if (!Object.hasOwn(value, "default")) {
      context.addIssue({ code: "custom", message: "default localized text is required" });
    }
    for (const key of Object.keys(value)) {
      if (key === "default") continue;
      try {
        if (Intl.getCanonicalLocales(key)[0] !== key) {
          context.addIssue({ code: "custom", message: "localized text keys must be canonical" });
        }
      } catch {
        context.addIssue({ code: "custom", message: "localized text keys must be language tags" });
      }
    }
  }),
]);
