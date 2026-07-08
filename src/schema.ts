import { z } from "zod";

export const LINES_OF_BUSINESS = [
  "general_liability",
  "commercial_property",
  "workers_compensation",
  "commercial_auto",
  "bop",
] as const;

export type LineOfBusiness = (typeof LINES_OF_BUSINESS)[number];

// The README field table constrains contactEmail only to "string". This loose
// shape check is deliberately weaker than RFC-grade validation (zod's z.email())
// so we never reject an address the AMS itself would accept.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirrors the AMS field table in README.md exactly.
export const RecordSchema = z.object({
  insuredName: z.string().min(1),
  dba: z.string().min(1).nullable(),
  mailingAddress: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
    state: z.string().regex(/^[A-Z]{2}$/),
    zip: z.string().regex(/^\d{5}$/),
  }),
  lineOfBusiness: z.enum(LINES_OF_BUSINESS),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  annualRevenue: z.number().nullable(),
  contactEmail: z.string().regex(EMAIL_RE),
});

export type RecordPayload = z.infer<typeof RecordSchema>;
export type MailingAddress = RecordPayload["mailingAddress"];
