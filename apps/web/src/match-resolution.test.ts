import { describe, expect, it } from "vitest";
import { extractMatchCandidates, resolveMatchIdentity } from "./match-resolution";

describe("match resolution", () => {
  const catalog = {
    games: [
      {
        gameId: "dal-hou-2025-01-01",
        homeTeam: { code: "HOU", name: "Houston Rockets" },
        awayTeam: { code: "DAL", name: "Dallas Mavericks" },
        finalScore: [107, 103],
        players: [{ name: "Luka Doncic", jerseyNumber: "77" }, { name: "Alperen Sengun", jerseyNumber: "28" }],
        source: "official catalog"
      },
      {
        gameId: "lal-bos-2025-01-02",
        homeTeam: { code: "BOS", name: "Boston Celtics" },
        awayTeam: { code: "LAL", name: "Los Angeles Lakers" },
        finalScore: [110, 106],
        players: [{ name: "Jayson Tatum", jerseyNumber: "0" }],
        source: "official catalog"
      }
    ]
  };

  it("extracts candidates and confirms only when multiple independent clues agree", () => {
    const candidates = extractMatchCandidates(catalog);
    expect(candidates).toHaveLength(2);
    const result = resolveMatchIdentity([
      { type: "team", value: "DAL vs HOU", confidence: 0.95, source: "scoreboard OCR" },
      { type: "player", value: "Luka Doncic", confidence: 0.88, source: "roster OCR" },
      { type: "scoreboard", value: "107-103", confidence: 0.82, source: "scoreboard OCR" }
    ], candidates);
    expect(result.status).toBe("confirmed");
    expect(result.selectedGameId).toBe("dal-hou-2025-01-01");
  });

  it("does not select a game when evidence is missing or tied", () => {
    const candidates = extractMatchCandidates(catalog);
    expect(resolveMatchIdentity([], candidates).status).toBe("unconfirmed");
    const result = resolveMatchIdentity([
      { type: "team", value: "DAL", confidence: 0.7, source: "scoreboard OCR" }
    ], candidates);
    expect(result.status).toBe("unconfirmed");
    expect(result.selectedGameId).toBeUndefined();
  });
});
