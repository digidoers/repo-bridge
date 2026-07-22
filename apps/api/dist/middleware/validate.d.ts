import type { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";
/**
 * Validates request body against a Zod schema.
 * Returns 400 with structured field errors on failure.
 */
export declare function validate(schema: ZodSchema): (req: Request, _res: Response, next: NextFunction) => void;
//# sourceMappingURL=validate.d.ts.map