import { z } from "zod";
export const registerRepoSchema = z.object({
    githubOwner: z
        .string()
        .min(1, "GitHub owner/organization name is required")
        .transform((v) => v.trim()),
    githubName: z
        .string()
        .min(1, "GitHub repository name is required")
        .transform((v) => v.trim()),
    role: z.enum(["MAIN", "CLIENT"], {
        errorMap: () => ({ message: "Role must be either MAIN or CLIENT" }),
    }),
    branch: z
        .string()
        .min(1, "Branch name cannot be empty")
        .default("master")
        .transform((v) => v.trim()),
    description: z
        .string()
        .max(500, "Description must be at most 500 characters")
        .optional()
        .transform((v) => v?.trim() || null),
    customerName: z
        .string()
        .max(100, "Customer name must be at most 100 characters")
        .optional()
        .transform((v) => v?.trim() || null),
    autoMergeEnabled: z.boolean().default(false).optional(),
});
export const updateRepoSchema = z.object({
    branch: z
        .string()
        .min(1, "Branch name cannot be empty")
        .optional()
        .transform((v) => v?.trim()),
    description: z
        .string()
        .max(500, "Description must be at most 500 characters")
        .optional()
        .transform((v) => v?.trim() || null),
    customerName: z
        .string()
        .max(100, "Customer name must be at most 100 characters")
        .optional()
        .transform((v) => v?.trim() || null),
    isActive: z.boolean().optional(),
    autoMergeEnabled: z.boolean().optional(),
});
//# sourceMappingURL=repos.schemas.js.map