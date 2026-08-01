import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACK_CONTRACT,
  STEERING_CONTRACT,
  blockMessage,
} from "../adapters/shared/conversational.ts";
import { PERSONA_APPEND } from "../adapters/pi/runtime.ts";

describe("conversational contracts", () => {
  it("exports stable steering and ack contracts", () => {
    assert.equal(STEERING_CONTRACT, "NOT EXECUTED — human steering: ");
    assert.equal(
      ACK_CONTRACT,
      "NOT EXECUTED — checkpoint acknowledged; re-issue this call and continue as planned",
    );
  });

  it("blockMessage ends with STEERING_CONTRACT semantics", () => {
    const msg = blockMessage("── checkpoint ──\n+10 lines");
    assert.match(msg, /NOT EXECUTED/);
    assert.match(msg, /Relay this checkpoint to the user/);
    assert.ok(msg.includes(STEERING_CONTRACT));
    assert.match(msg, /awaiting user reply/);
  });

  it("persona append names both contracts and re-issue instruction", () => {
    assert.match(PERSONA_APPEND, /human steering/);
    assert.match(PERSONA_APPEND, /re-issue the same call unchanged/);
    assert.ok(PERSONA_APPEND.includes(ACK_CONTRACT));
  });
});
