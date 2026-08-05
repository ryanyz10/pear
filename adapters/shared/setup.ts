#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { DEFAULTS, parseModel, saveUserConfig } from "../../core/config.ts";

const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log("pear setup — choose the model pear's navigator uses to review your uncommitted changes.");
const answer = (
  await rl.question(`Model as provider/id (e.g. anthropic/claude-sonnet-4-5) [${DEFAULTS.navModel}]: `)
).trim();
rl.close();
const navModel = answer || DEFAULTS.navModel;
parseModel(navModel); // throws with a clear message on malformed input; non-zero exit
saveUserConfig(homedir(), { navModel });
console.log(`Saved — pear will use ${navModel} for the navigator across all projects.`);
