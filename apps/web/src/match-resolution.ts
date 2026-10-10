import {
  matchCandidateSchema,
  matchEvidenceSchema,
  matchResolutionSchema,
  type MatchCandidate,
  type MatchEvidence,
  type MatchResolution
} from "@courtvision/contracts";

type RecordValue = Record<string, unknown>;

const asRecord = (value: unknown): RecordValue | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const asText = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined;
const firstText = (record: RecordValue, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = asText(record[key]);
    if (value) return value;
  }
  return undefined;
};

const normalize = (value: string): string => value.toLocaleLowerCase("en-US").normalize("NFKC").replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
const containsTerm = (text: string, term: string): boolean => {
  const haystack = normalize(text);
  const needle = normalize(term);
  if (!haystack || !needle) return false;
  if (needle.length <= 3 && /^[a-z0-9]+$/i.test(needle)) return new RegExp(`(^|\\s)${needle}(?=\\s|$)`, "i").test(haystack);
  return haystack.includes(needle);
};

const parseTeam = (value: unknown): { teamCode: string; teamName: string } | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const teamCode = firstText(record, ["teamCode", "code", "abbreviation", "abbrev", "shortName"]);
  const teamName = firstText(record, ["teamName", "name", "displayName", "fullName"]) ?? teamCode;
  if (!teamCode || !teamName || teamCode.length < 2) return undefined;
  return { teamCode: teamCode.toUpperCase(), teamName };
};

const parseCandidate = (value: unknown): MatchCandidate | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const rawTeams = Array.isArray(record.teams) ? record.teams : [record.homeTeam ?? record.home, record.awayTeam ?? record.away];
  const teams = rawTeams.map(parseTeam).filter((team): team is { teamCode: string; teamName: string } => Boolean(team));
  if (teams.length !== 2) return undefined;
  const gameId = firstText(record, ["gameId", "game_id", "id", "eventId"]);
  if (!gameId) return undefined;
  const finalScore = Array.isArray(record.finalScore) && record.finalScore.length === 2
    ? record.finalScore.map((score) => Number(score))
    : [record.homeScore ?? record.homePoints, record.awayScore ?? record.awayPoints].map((score) => Number(score));
  const normalizedScore = finalScore.every((score) => Number.isFinite(score) && score >= 0) ? finalScore : undefined;
  const players = Array.isArray(record.players) ? record.players : [];
  const playerNames = players.map((player) => firstText(asRecord(player) ?? {}, ["name", "playerName", "displayName"])).filter((name): name is string => Boolean(name));
  const jerseyNumbers = players.map((player) => firstText(asRecord(player) ?? {}, ["jerseyNumber", "number"])).filter((number): number is string => typeof number === "string" && /^\d{1,2}$/.test(number));
  const source = firstText(record, ["source", "sourceUrl", "provider"]) ?? "candidate catalog";
  return matchCandidateSchema.parse({
    gameId,
    teams,
    gameDate: firstText(record, ["gameDate", "date", "startTime"]),
    finalScore: normalizedScore,
    playerNames: [...new Set(playerNames)],
    jerseyNumbers: [...new Set(jerseyNumbers)],
    source
  });
};

export const extractMatchCandidates = (value: unknown): MatchCandidate[] => {
  const candidates: MatchCandidate[] = [];
  const seenObjects = new Set<unknown>();
  const seenIds = new Set<string>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 7 || !current || typeof current !== "object" || seenObjects.has(current)) return;
    seenObjects.add(current);
    const candidate = parseCandidate(current);
    if (candidate && !seenIds.has(candidate.gameId)) {
      seenIds.add(candidate.gameId);
      candidates.push(candidate);
    }
    if (Array.isArray(current)) {
      current.slice(0, 2000).forEach((item) => visit(item, depth + 1));
    } else {
      Object.values(current as RecordValue).forEach((item) => visit(item, depth + 1));
    }
  };
  visit(value, 0);
  return candidates;
};

const evidenceText = (evidence: MatchEvidence[]): string => evidence.map((item) => item.value).join(" ");
const scorePair = (text: string): [number, number] | undefined => {
  const match = text.match(/\b(\d{1,3})\s*[-:]\s*(\d{1,3})\b/);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
};

export const resolveMatchIdentity = (evidence: MatchEvidence[], candidates: MatchCandidate[]): MatchResolution => {
  const parsedEvidence = evidence.filter((item) => matchEvidenceSchema.safeParse(item).success);
  if (!parsedEvidence.length || !candidates.length) {
    return matchResolutionSchema.parse({
      status: "unconfirmed",
      confidence: 0,
      candidates: [],
      evidence: parsedEvidence,
      warnings: [candidates.length ? "视频没有提取到可用于比赛匹配的证据。" : "没有加载可检索的比赛候选数据。"]
    });
  }
  const text = evidenceText(parsedEvidence);
  const observedScore = scorePair(text);
  const ranked = candidates.map((candidate) => {
    let raw = 0;
    let matchedSignals = 0;
    const reasons: string[] = [];
    const teamHits = candidate.teams.filter((team) => parsedEvidence.some((item) => containsTerm(item.value, team.teamCode) || containsTerm(item.value, team.teamName)));
    if (teamHits.length === 2) {
      raw += 0.52;
      matchedSignals += 1;
      reasons.push(`识别到两支球队：${teamHits.map((team) => team.teamCode).join(" / ")}`);
    } else if (teamHits.length === 1) {
      raw += 0.22;
      matchedSignals += 1;
      reasons.push(`识别到球队：${teamHits[0]!.teamCode}`);
    }
    const playerHits = candidate.playerNames.filter((name) => parsedEvidence.some((item) => containsTerm(item.value, name)));
    if (playerHits.length) {
      raw += Math.min(0.22, playerHits.length * 0.11);
      matchedSignals += 1;
      reasons.push(`球员线索匹配 ${playerHits.length} 人`);
    }
    const numberHits = candidate.jerseyNumbers.filter((number) => parsedEvidence.some((item) => item.type === "jersey" && containsTerm(item.value, number)));
    if (numberHits.length) {
      raw += Math.min(0.12, numberHits.length * 0.04);
      matchedSignals += 1;
      reasons.push(`号码线索匹配 ${numberHits.length} 个`);
    }
    if (observedScore && candidate.finalScore && observedScore.every((score, index) => score === candidate.finalScore?.[index])) {
      raw += 0.25;
      matchedSignals += 1;
      reasons.push("比分线索与候选比赛一致");
    }
    const confidence = parsedEvidence.reduce((sum, item) => sum + item.confidence, 0) / parsedEvidence.length;
    const score = Math.min(1, raw * (0.65 + confidence * 0.35));
    return { gameId: candidate.gameId, score: Number(score.toFixed(3)), reasons, matchedSignals };
  }).sort((left, right) => right.score - left.score);
  const top = ranked[0];
  const second = ranked[1];
  const margin = top ? top.score - (second?.score ?? 0) : 0;
  const confirmed = Boolean(top && top.score >= 0.68 && margin >= 0.12 && top.matchedSignals >= 2);
  const status = confirmed ? "confirmed" : top && top.score >= 0.28 ? "ambiguous" : "unconfirmed";
  return matchResolutionSchema.parse({
    status,
    confidence: top?.score ?? 0,
    selectedGameId: confirmed ? top?.gameId : undefined,
    candidates: ranked.slice(0, 5).map(({ gameId, score, reasons }) => ({ gameId, score, reasons: reasons.length ? reasons : ["没有足够的匹配证据"] })),
    evidence: parsedEvidence,
    warnings: status === "confirmed" ? [] : [status === "ambiguous" ? "多个候选比赛仍然接近，暂不填充官方统计。" : "比赛身份证据不足，暂不填充官方统计。"]
  });
};
