import { describe, expect, it } from "vitest";
import { getWinnerSlotCount, selectWinners, type Completer } from "../lib/raceSettlement.js";

// Pure-function tests for the completion-gated winner rules (spec: WINNER SELECTION AND FORFEIT LOGIC).

describe("getWinnerSlotCount", () => {
  it("2 participants → max 1 winner", () => expect(getWinnerSlotCount(2)).toBe(1));
  it("3 participants → max 2 winners", () => expect(getWinnerSlotCount(3)).toBe(2));
  it("4 participants → max 3 winners", () => expect(getWinnerSlotCount(4)).toBe(3));
  it("10 participants → max 3 winners", () => expect(getWinnerSlotCount(10)).toBe(3));

  it("every count in 4–10 → 3 winners", () => {
    for (let n = 4; n <= 10; n++) expect(getWinnerSlotCount(n)).toBe(3);
  });

  it("fewer than 2 participants → 0 winners", () => {
    expect(getWinnerSlotCount(0)).toBe(0);
    expect(getWinnerSlotCount(1)).toBe(0);
  });

  it("more than 10 participants → 0 winners", () => {
    expect(getWinnerSlotCount(11)).toBe(0);
    expect(getWinnerSlotCount(50)).toBe(0);
  });
});

const completer = (
  id: string,
  goalCompletedAtMs: number,
  finishRank: number | null = null,
  finalSteps = 10_000,
): Completer => ({ participantId: id, userId: `user-${id}`, goalCompletedAtMs, finishRank, finalSteps });

describe("selectWinners", () => {
  it("returns zero winners when nobody completed", () => {
    expect(selectWinners([], 3)).toEqual([]);
  });

  it("returns zero winners when slot count is 0 (e.g. 1-player or >10-player race)", () => {
    expect(selectWinners([completer("a", 100)], 0)).toEqual([]);
  });

  it("ranks winners by earliest completion time", () => {
    const winners = selectWinners([completer("b", 200), completer("a", 100), completer("c", 300)], 3);
    expect(winners.map((w) => w.participantId)).toEqual(["a", "b", "c"]);
    expect(winners.map((w) => w.position)).toEqual([1, 2, 3]);
  });

  it("never returns more winners than the slot count", () => {
    const winners = selectWinners([completer("a", 100), completer("b", 200), completer("c", 300)], 1);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.participantId).toBe("a");
  });

  it("fewer completers than slots → fewer winners (unfilled slots left empty)", () => {
    const winners = selectWinners([completer("a", 100)], 3);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.position).toBe(1);
  });

  it("breaks an identical completion time by the authoritative acceptance ordinal", () => {
    const winners = selectWinners([completer("b", 100, 5), completer("a", 100, 2)], 2);
    expect(winners.map((w) => w.participantId)).toEqual(["a", "b"]);
    expect(winners.map((w) => w.position)).toEqual([1, 2]);
  });

  it("falls back to participantId when time AND ordinal are identical — still no tie", () => {
    const winners = selectWinners([completer("z", 100, 1), completer("a", 100, 1)], 2);
    expect(winners.map((w) => w.participantId)).toEqual(["a", "z"]);
    // Strictly unique, sequential positions — never a shared rank.
    expect(winners.map((w) => w.position)).toEqual([1, 2]);
  });

  it("always produces strictly unique positions", () => {
    const winners = selectWinners(
      [completer("a", 100), completer("b", 100), completer("c", 100), completer("d", 100)],
      3,
    );
    const positions = winners.map((w) => w.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions).toEqual([1, 2, 3]);
  });

  it("10 completers, 3 slots → exactly 3 winners in completion order", () => {
    const many = Array.from({ length: 10 }, (_, i) => completer(`p${i}`, 100 + i));
    const winners = selectWinners(many, 3);
    expect(winners).toHaveLength(3);
    expect(winners.map((w) => w.participantId)).toEqual(["p0", "p1", "p2"]);
  });

  it("does not mutate the input array", () => {
    const input = [completer("b", 200), completer("a", 100)];
    const snapshot = input.map((c) => c.participantId);
    selectWinners(input, 2);
    expect(input.map((c) => c.participantId)).toEqual(snapshot);
  });
});
