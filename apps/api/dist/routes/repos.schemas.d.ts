import { z } from "zod";
export declare const registerRepoSchema: z.ZodObject<{
    githubOwner: z.ZodEffects<z.ZodString, string, string>;
    githubName: z.ZodEffects<z.ZodString, string, string>;
    role: z.ZodEnum<["MAIN", "CLIENT"]>;
    branch: z.ZodEffects<z.ZodDefault<z.ZodString>, string, string | undefined>;
    description: z.ZodEffects<z.ZodOptional<z.ZodString>, string | null, string | undefined>;
    customerName: z.ZodEffects<z.ZodOptional<z.ZodString>, string | null, string | undefined>;
    autoMergeEnabled: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    githubOwner: string;
    githubName: string;
    role: "MAIN" | "CLIENT";
    branch: string;
    description: string | null;
    customerName: string | null;
    autoMergeEnabled?: boolean | undefined;
}, {
    githubOwner: string;
    githubName: string;
    role: "MAIN" | "CLIENT";
    branch?: string | undefined;
    description?: string | undefined;
    customerName?: string | undefined;
    autoMergeEnabled?: boolean | undefined;
}>;
export declare const updateRepoSchema: z.ZodObject<{
    branch: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, string | undefined>;
    description: z.ZodEffects<z.ZodOptional<z.ZodString>, string | null, string | undefined>;
    customerName: z.ZodEffects<z.ZodOptional<z.ZodString>, string | null, string | undefined>;
    isActive: z.ZodOptional<z.ZodBoolean>;
    autoMergeEnabled: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    description: string | null;
    customerName: string | null;
    branch?: string | undefined;
    isActive?: boolean | undefined;
    autoMergeEnabled?: boolean | undefined;
}, {
    branch?: string | undefined;
    description?: string | undefined;
    customerName?: string | undefined;
    isActive?: boolean | undefined;
    autoMergeEnabled?: boolean | undefined;
}>;
export type RegisterRepoInput = z.infer<typeof registerRepoSchema>;
export type UpdateRepoInput = z.infer<typeof updateRepoSchema>;
//# sourceMappingURL=repos.schemas.d.ts.map