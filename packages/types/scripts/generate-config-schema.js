import { z } from "zod";
import { ConfigSchema } from "../src/index.ts";

const schema = z.toJSONSchema(ConfigSchema, { io: "input" });

await Bun.write(
  new URL("../config.schema.json", import.meta.url),
  `${JSON.stringify(schema, null, 2)}\n`,
);
