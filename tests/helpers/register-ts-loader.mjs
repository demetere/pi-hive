import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tests/helpers/ts-extension-loader.mjs", pathToFileURL("./"));
