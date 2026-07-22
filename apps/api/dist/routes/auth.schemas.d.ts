import { z } from "zod";
export declare const signupSchema: z.ZodObject<{
    name: z.ZodString;
    email: z.ZodEffects<z.ZodString, string, string>;
    password: z.ZodString;
}, "strip", z.ZodTypeAny, {
    name: string;
    email: string;
    password: string;
}, {
    name: string;
    email: string;
    password: string;
}>;
export declare const loginSchema: z.ZodObject<{
    email: z.ZodEffects<z.ZodString, string, string>;
    password: z.ZodString;
}, "strip", z.ZodTypeAny, {
    email: string;
    password: string;
}, {
    email: string;
    password: string;
}>;
export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
//# sourceMappingURL=auth.schemas.d.ts.map