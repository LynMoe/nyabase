import { z } from 'zod';

export const zBrowserToConsole = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth'),
    token: z.string().min(1).max(16_384),
  }).strict(),
  z.object({
    type: z.literal('input'),
    data: z.string().max(1_048_576),
  }).strict(),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }).strict(),
]);

export const zConsoleToBrowser = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
  }).strict(),
  z.object({
    type: z.literal('data'),
    data: z.string().max(1_048_576),
    stderr: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('eof'),
    exitCode: z.number().int().nullable(),
  }).strict(),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4_096),
  }).strict(),
]);

export type BrowserToConsole = z.infer<typeof zBrowserToConsole>;
export type ConsoleToBrowser = z.infer<typeof zConsoleToBrowser>;
