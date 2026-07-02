import { defineLibraryConfig } from "../../rslib.base.ts";

export default defineLibraryConfig({
  entry: {
    index: "./src/index.ts",
    "db/schema/auth": "./src/db/schema/auth.ts",
  },
});
