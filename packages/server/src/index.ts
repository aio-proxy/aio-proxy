import { Hono } from "hono";

export const app = new Hono();
export type AppType = typeof app;
