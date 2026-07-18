import { expect, test } from "@rstest/core";
import config from "./rsbuild.config";

test("development server matches the advertised Dashboard endpoint", () => {
  expect(config).toMatchObject({
    server: {
      host: "127.0.0.1",
      port: 3000,
      strictPort: true,
      proxy: {
        "/dashboard/api": { target: "http://127.0.0.1:22078" },
      },
    },
  });
});
