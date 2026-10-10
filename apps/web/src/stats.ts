import { gameStatsTimelineSchema, type GameStatsSnapshot, type GameStatsTimeline, type TeamStats } from "@courtvision/contracts";

export const demoStatsTimeline: GameStatsTimeline = gameStatsTimelineSchema.parse({
  version: "1.0",
  gameId: "dal-hou-showcase",
  source: "showcase demo box score",
  isDemo: true,
  snapshots: [
    {
      atSeconds: 0,
      period: 4,
      clock: "01:52",
      teams: [
        { teamCode: "DAL", teamName: "Dallas Mavericks", score: 103, fieldGoals: { made: 38, attempted: 81 }, threePoints: { made: 12, attempted: 31 }, freeThrows: { made: 15, attempted: 19 }, assists: 24, turnovers: 11, rebounds: { offensive: 9, defensive: 31 }, steals: 7, blocks: 4, fouls: { period: 2, game: 18 }, paintPoints: 42, fastBreakPoints: 12, secondChancePoints: 11, benchPoints: 24, largestLead: 8 },
        { teamCode: "HOU", teamName: "Houston Rockets", score: 107, fieldGoals: { made: 41, attempted: 85 }, threePoints: { made: 13, attempted: 34 }, freeThrows: { made: 12, attempted: 17 }, assists: 26, turnovers: 9, rebounds: { offensive: 11, defensive: 29 }, steals: 5, blocks: 6, fouls: { period: 3, game: 20 }, paintPoints: 48, fastBreakPoints: 15, secondChancePoints: 14, benchPoints: 19, largestLead: 11 }
      ]
    }
  ]
});

export const findStatsSnapshot = (timeline: GameStatsTimeline | undefined, atSeconds: number): GameStatsSnapshot | undefined => {
  if (!timeline) return undefined;
  let result: GameStatsSnapshot | undefined;
  for (const snapshot of timeline.snapshots) {
    if (snapshot.atSeconds <= atSeconds) result = snapshot;
    else break;
  }
  return result;
};

export const percentage = (made?: number, attempted?: number): number | undefined => attempted ? Math.round((made ?? 0) / attempted * 100) : undefined;

export const statValue = (team: TeamStats, key: keyof TeamStats): string | number | undefined => {
  const value = team[key];
  return typeof value === "number" || typeof value === "string" ? value : undefined;
};
