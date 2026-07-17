import { join } from "node:path";
import { defineLibraryConfig } from "@aio-proxy/infra/rslib";
import { createLobeIconTypePlugin, prepareLobeIconTypeBuild, resolveLobeIconPackage } from "./build/lobe-icon-keys";

const rootPath = import.meta.dirname;
const lobeIcons = resolveLobeIconPackage(import.meta.url);
const lobeIconBuild = prepareLobeIconTypeBuild({
  ...lobeIcons,
  cachePath: join(rootPath, "node_modules", ".cache"),
});

export default defineLibraryConfig({
  root: rootPath,
  plugins: [createLobeIconTypePlugin({ declarationPath: lobeIconBuild.declarationPath, version: lobeIcons.version })],
  lib: [
    {
      id: "library",
      dts: {
        bundle: true,
      },
    },
  ],
  banner: { dts: lobeIconBuild.declaration },
});
