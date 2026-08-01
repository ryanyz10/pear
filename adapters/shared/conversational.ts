import { ACK_CONTRACT, STEERING_CONTRACT } from "../../core/checkpoint.ts";

/**
 * Conversational checkpoint block for dialog-less hosts (opencode, Claude Code, Cursor).
 * The model must relay the summary; the user's next chat reply is steering.
 */
export function blockMessage(summary: string): string {
  return (
    `${summary.trim()}\n\n` +
    `This action was NOT EXECUTED. Relay this checkpoint to the user; ` +
    `their reply is your steering (continue / adjust / stop).\n` +
    `${STEERING_CONTRACT}<awaiting user reply>`
  );
}

export { ACK_CONTRACT, STEERING_CONTRACT };
