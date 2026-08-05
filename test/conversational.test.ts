import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACK_CONTRACT,
  STEERING_CONTRACT,
  blockMessage,
} from "../adapters/shared/conversational.ts";
import { AGENT_DRIVER_PERSONA, HUMAN_DRIVER_PERSONA } from "../adapters/pi/runtime.ts";

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

  it("agent-driver persona names both contracts and the re-issue instruction", () => {
    assert.match(AGENT_DRIVER_PERSONA, /human steering/);
    assert.match(AGENT_DRIVER_PERSONA, /re-issue the same call unchanged/);
    assert.ok(AGENT_DRIVER_PERSONA.includes(ACK_CONTRACT));
  });

  it("human-driver persona names pear-nav findings as informational-only", () => {
    assert.match(HUMAN_DRIVER_PERSONA, /pear-nav/);
    assert.match(HUMAN_DRIVER_PERSONA, /informational/);
  });
});
