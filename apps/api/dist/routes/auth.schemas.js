import { z } from "zod";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, NAME_MAX_LENGTH, EMAIL_MAX_LENGTH, } from "@repo-sync/shared";
export const signupSchema = z.object({
    name: z
        .string()
        .min(1, "Name is required")
        .max(NAME_MAX_LENGTH, `Name must be at most ${NAME_MAX_LENGTH} characters`),
    email: z
        .string()
        .email("Invalid email address")
        .max(EMAIL_MAX_LENGTH, `Email must be at most ${EMAIL_MAX_LENGTH} characters`)
        .transform((v) => v.toLowerCase().trim()),
    password: z
        .string()
        .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
        .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`),
});
export const loginSchema = z.object({
    email: z
        .string()
        .email("Invalid email address")
        .transform((v) => v.toLowerCase().trim()),
    password: z.string().min(1, "Password is required"),
});
//# sourceMappingURL=auth.schemas.js.map