import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tests/helpers/poison-pi-package-loader.mjs", pathToFileURL("./"));
