import { loadState, saveState, sweepTurnEnd } from "../../shared/hook-checkpoint.ts";
import { readStdinJson, resolveCwd, writeJson } from "../../shared/hook-io.ts";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);
saveState(cwd, sweepTurnEnd(loadState(cwd)));
writeJson({});
