from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch
from dotenv import load_dotenv
from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse


ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")
DATA_ROOT = Path(os.getenv("COURTVISION_LOCAL_DATA", ROOT / ".local-data")).resolve()
DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"
MODEL_NAME = os.getenv("COURTVISION_VISION_MODEL", "yolo11s.pt")
TARGET_FPS = max(1.0, float(os.getenv("COURTVISION_TRACKING_FPS", "12")))
MODEL_SIZE = max(320, int(os.getenv("COURTVISION_MODEL_SIZE", "960" if DEVICE != "cpu" else "640")))
PLAYER_MIN_CONFIDENCE = max(0.05, min(0.95, float(os.getenv("COURTVISION_PLAYER_MIN_CONFIDENCE", "0.45"))))
BALL_MIN_CONFIDENCE = max(0.05, min(0.95, float(os.getenv("COURTVISION_BALL_MIN_CONFIDENCE", "0.18"))))
SCOREBOARD_INTERVAL_SECONDS = max(1.0, float(os.getenv("COURTVISION_SCOREBOARD_INTERVAL_SECONDS", "3")))
MIN_TRACK_SECONDS = max(0.2, float(os.getenv("COURTVISION_MIN_TRACK_SECONDS", "0.65")))
TRACK_MERGE_GAP_SECONDS = max(0.1, float(os.getenv("COURTVISION_TRACK_MERGE_GAP_SECONDS", "0.9")))
TEAM_CLUSTER_MIN_DISTANCE = max(1.0, float(os.getenv("COURTVISION_TEAM_CLUSTER_MIN_DISTANCE", "38")))
AUTO_REFEREE_FILTER = os.getenv("COURTVISION_AUTO_REFEREE_FILTER", "1").strip().lower() in {"1", "true", "yes"}
PLAYER_CLASS_ID = int(os.getenv("COURTVISION_PLAYER_CLASS_ID", "0"))
BALL_CLASS_ID = int(os.getenv("COURTVISION_BALL_CLASS_ID", "32"))
DETECTOR_CLASSES = tuple(
    int(value.strip()) for value in os.getenv("COURTVISION_DETECTOR_CLASSES", "0,32").split(",")
    if value.strip().isdigit()
) or (0, 32)
TRACKER_CONFIG = Path(__file__).with_name("courtvision_botsort.yaml")
TESSERACT_PATH = os.getenv("COURTVISION_TESSERACT_PATH") or shutil.which("tesseract")

DATA_ROOT.mkdir(parents=True, exist_ok=True)
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="courtvision")
model_lock = threading.Lock()
model_instance: Any | None = None

app = FastAPI(title="CourtVision Local Vision", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_name(value: str | None, fallback: str) -> str:
    name = Path(value or fallback).name
    cleaned = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "-", name, flags=re.UNICODE).strip("-.")
    return cleaned or fallback


def job_dir(job_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f-]{36}", job_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    return DATA_ROOT / "jobs" / job_id


def read_job(job_id: str) -> dict[str, Any]:
    path = job_dir(job_id) / "job.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="任务不存在")
    return json.loads(path.read_text(encoding="utf-8"))


def write_job(job_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    directory = job_dir(job_id)
    path = directory / "job.json"
    current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    current.update(changes)
    current["updatedAt"] = utc_now()
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    return current


def get_model() -> Any:
    global model_instance
    with model_lock:
        if model_instance is None:
            from ultralytics import YOLO

            model_instance = YOLO(MODEL_NAME)
    return model_instance


def jersey_features(frame: np.ndarray, box: list[float]) -> list[float] | None:
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = box
    left = max(0, min(width - 1, int(x1 + (x2 - x1) * 0.22)))
    right = max(left + 1, min(width, int(x1 + (x2 - x1) * 0.78)))
    top = max(0, min(height - 1, int(y1 + (y2 - y1) * 0.18)))
    bottom = max(top + 1, min(height, int(y1 + (y2 - y1) * 0.52)))
    crop = frame[top:bottom, left:right]
    if crop.size == 0:
        return None
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    lightness = lab[:, :, 0]
    saturation = hsv[:, :, 1]
    return [
        float(np.median(lightness)),
        float(np.median(saturation)),
        float(np.std(lightness)),
    ]


def is_court_person(box: dict[str, float]) -> bool:
    """Reject score-bug, bench and crowd detections before they become player tracks."""
    bottom = box["y"] + box["height"]
    center_x = box["x"] + box["width"] / 2
    aspect = box["height"] / max(box["width"], 0.001)
    area = box["width"] * box["height"]
    return (
        box["height"] >= 0.06
        and box["height"] <= 0.62
        and area >= 0.0012
        and 0.035 <= center_x <= 0.965
        and bottom >= 0.38
        and bottom <= 0.90
        and 0.85 <= aspect <= 5.8
    )


def referee_candidate(features: list[list[float]]) -> bool:
    """Only emit a referee candidate for unusually strong grayscale evidence."""
    if len(features) < 10:
        return False
    lightness, saturation, contrast = np.median(features, axis=0)
    return 62 <= lightness <= 160 and saturation <= 31 and contrast >= 56


def box_center(box: dict[str, float]) -> tuple[float, float]:
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def filter_ball_candidates(frames: list[dict[str, Any]]) -> int:
    """Remove isolated COCO sports-ball false positives while retaining fast, supported motion."""
    removed = 0
    for index, frame in enumerate(frames):
        ball = frame.get("ball")
        if not isinstance(ball, dict):
            continue
        current_x, current_y = box_center(ball["box"])
        supported = False
        for neighbor_index in (index - 2, index - 1, index + 1, index + 2):
            if neighbor_index < 0 or neighbor_index >= len(frames):
                continue
            neighbor = frames[neighbor_index].get("ball")
            if not isinstance(neighbor, dict):
                continue
            delta_seconds = abs(frames[neighbor_index]["atSeconds"] - frame["atSeconds"])
            if delta_seconds <= 0:
                continue
            neighbor_x, neighbor_y = box_center(neighbor["box"])
            distance = math.hypot(neighbor_x - current_x, neighbor_y - current_y)
            if distance <= 0.055 + 1.55 * delta_seconds:
                supported = True
                break
        if not supported and ball["confidence"] < 0.48:
            frame.pop("ball", None)
            removed += 1
    return removed


def merge_track_fragments(
    frames: list[dict[str, Any]],
    valid_tracks: set[int],
    track_colors: dict[int, list[list[float]]],
) -> dict[int, int]:
    """Join non-overlapping Bot-SORT fragments only when space, scale and jersey color agree."""
    observations: dict[int, list[tuple[float, dict[str, float]]]] = {track_id: [] for track_id in valid_tracks}
    for frame in frames:
        for player in frame["players"]:
            track_id = player["trackId"]
            if track_id in observations:
                observations[track_id].append((frame["atSeconds"], player["box"]))

    records: list[dict[str, Any]] = []
    for track_id, items in observations.items():
        if not items:
            continue
        first_time, first_box = items[0]
        last_time, last_box = items[-1]
        colors = track_colors.get(track_id, [])
        records.append({
            "trackId": track_id,
            "firstTime": first_time,
            "firstBox": first_box,
            "lastTime": last_time,
            "lastBox": last_box,
            "color": np.median(colors, axis=0) if len(colors) >= 3 else None,
        })
    records.sort(key=lambda item: (item["firstTime"], item["trackId"]))
    remap = {track_id: track_id for track_id in valid_tracks}

    for later in records:
        candidates: list[tuple[float, dict[str, Any]]] = []
        later_x, later_y = box_center(later["firstBox"])
        for earlier in records:
            if earlier["trackId"] == later["trackId"] or earlier["lastTime"] >= later["firstTime"]:
                continue
            gap = later["firstTime"] - earlier["lastTime"]
            if gap > TRACK_MERGE_GAP_SECONDS:
                continue
            earlier_x, earlier_y = box_center(earlier["lastBox"])
            distance = math.hypot(later_x - earlier_x, later_y - earlier_y)
            max_distance = 0.035 + gap * 0.14
            height_ratio = later["firstBox"]["height"] / max(earlier["lastBox"]["height"], 0.001)
            if distance > max_distance or not 0.66 <= height_ratio <= 1.5:
                continue
            if later["color"] is None or earlier["color"] is None:
                continue
            color_distance = float(np.linalg.norm((later["color"] - earlier["color"]) / np.array([52, 46, 34])))
            if color_distance > 0.82:
                continue
            candidates.append((distance / max_distance + color_distance, earlier))
        if candidates:
            _, best = min(candidates, key=lambda item: item[0])
            remap[later["trackId"]] = remap[best["trackId"]]
    return remap


def apply_track_remap(frames: list[dict[str, Any]], remap: dict[int, int]) -> None:
    for frame in frames:
        deduplicated: dict[int, dict[str, Any]] = {}
        for player in frame["players"]:
            track_id = remap.get(player["trackId"], player["trackId"])
            player["trackId"] = track_id
            existing = deduplicated.get(track_id)
            if existing is None or player["confidence"] > existing["confidence"]:
                deduplicated[track_id] = player
        frame["players"] = list(deduplicated.values())


def jersey_number_crop(frame: np.ndarray, box: list[float]) -> np.ndarray | None:
    """Keep a tight upper-torso crop for later multi-frame jersey-number OCR."""
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = box
    left = max(0, min(width - 1, int(x1 + (x2 - x1) * 0.2)))
    right = max(left + 1, min(width, int(x1 + (x2 - x1) * 0.8)))
    top = max(0, min(height - 1, int(y1 + (y2 - y1) * 0.2)))
    bottom = max(top + 1, min(height, int(y1 + (y2 - y1) * 0.68)))
    crop = frame[top:bottom, left:right]
    return crop.copy() if crop.shape[0] >= 28 and crop.shape[1] >= 18 else None


def ocr_jersey_number(crop: np.ndarray) -> str | None:
    if not TESSERACT_PATH:
        return None
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(6, 6)).apply(gray)
    ok, encoded = cv2.imencode(".png", gray)
    if not ok:
        return None
    try:
        result = subprocess.run(
            [str(TESSERACT_PATH), "stdin", "stdout", "--psm", "10", "-c", "tessedit_char_whitelist=0123456789"],
            input=encoded.tobytes(), capture_output=True, timeout=3, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    matched = re.search(r"\d{1,2}", result.stdout.decode("utf-8", errors="ignore"))
    return matched.group(0) if matched else None


def ocr_scoreboard_text(frame: np.ndarray) -> str | None:
    """Read the broadcast score bug as evidence; it is never treated as verified game data."""
    if not TESSERACT_PATH or frame.size == 0:
        return None
    height, width = frame.shape[:2]
    crop = frame[: max(1, int(height * 0.24)), :]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=2.5, fy=2.5, interpolation=cv2.INTER_CUBIC)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    ok, encoded = cv2.imencode(".png", gray)
    if not ok:
        return None
    try:
        result = subprocess.run(
            [str(TESSERACT_PATH), "stdin", "stdout", "--psm", "6"],
            input=encoded.tobytes(), capture_output=True, timeout=3, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = re.sub(r"\s+", " ", result.stdout.decode("utf-8", errors="ignore")).strip()
    return text[:240] if len(text) >= 2 else None


def vote_jersey_numbers(crops: dict[int, list[np.ndarray]]) -> dict[int, tuple[str, float]]:
    """A number is usable only after several independent reads agree."""
    outcomes: dict[int, tuple[str, float]] = {}
    for track_id, samples in crops.items():
        if not samples:
            continue
        votes: dict[str, int] = {}
        for sample in samples[:8]:
            number = ocr_jersey_number(sample)
            if number:
                votes[number] = votes.get(number, 0) + 1
        if not votes:
            continue
        number, count = max(votes.items(), key=lambda item: item[1])
        confidence = count / len(samples[:8])
        if count >= 3 and confidence >= 0.6:
            outcomes[track_id] = (number, round(confidence, 3))
    return outcomes


def assign_teams(
    frames: list[dict[str, Any]],
    track_colors: dict[int, list[list[float]]],
    player_tracks: set[int],
) -> dict[int, str]:
    eligible = sorted(track_id for track_id, colors in track_colors.items() if track_id in player_tracks and len(colors) >= 3)
    if len(eligible) < 2:
        return {}
    features = np.float32([np.median(track_colors[track_id], axis=0) for track_id in eligible])
    _, labels, centers = cv2.kmeans(
        features,
        2,
        None,
        (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.2),
        8,
        cv2.KMEANS_PP_CENTERS,
    )
    if float(np.linalg.norm(centers[0] - centers[1])) < TEAM_CLUSTER_MIN_DISTANCE:
        return {}
    order = np.argsort(centers[:, 0])
    cluster_name = {int(order[0]): "team-a", int(order[1]): "team-b"}
    mapping = {track_id: cluster_name[int(labels[index][0])] for index, track_id in enumerate(eligible)}
    for frame in frames:
        for player in frame["players"]:
            player["team"] = mapping.get(player["trackId"], "unknown")
    return mapping


def parse_roster(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("名单文件必须是 UTF-8 编码的合法 JSON") from error
    if isinstance(raw, dict) and isinstance(raw.get("roster"), dict):
        raw = raw["roster"]
    if not isinstance(raw, dict) or raw.get("version") != "1.0":
        raise ValueError("名单文件缺少 version: 1.0")
    game_id = raw.get("gameId")
    teams = raw.get("teams")
    if not isinstance(game_id, str) or not game_id.strip() or not isinstance(teams, list) or len(teams) != 2:
        raise ValueError("名单文件必须包含 gameId 和恰好两支 teams")
    seen_teams: set[str] = set()
    seen_player_ids: set[str] = set()
    normalized_teams: list[dict[str, Any]] = []
    for team in teams:
        if not isinstance(team, dict):
            raise ValueError("teams 中每项必须是对象")
        code = team.get("teamCode")
        name = team.get("teamName")
        players = team.get("players")
        if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9]{2,8}", code) or not isinstance(name, str) or not name.strip():
            raise ValueError("每支球队必须包含 teamCode 和 teamName")
        code = code.upper()
        if code in seen_teams:
            raise ValueError("teamCode 不能重复")
        seen_teams.add(code)
        if not isinstance(players, list) or not players:
            raise ValueError(f"{code} 必须至少包含一名球员")
        numbers: set[str] = set()
        normalized_players: list[dict[str, Any]] = []
        for player in players:
            if not isinstance(player, dict):
                raise ValueError(f"{code} 的球员项必须是对象")
            player_id = player.get("playerId")
            player_name = player.get("name")
            number = str(player.get("jerseyNumber", "")).strip()
            if not isinstance(player_id, str) or not player_id.strip() or not isinstance(player_name, str) or not player_name.strip() or not re.fullmatch(r"\d{1,2}", number):
                raise ValueError(f"{code} 的每名球员需要 playerId、name 和 1-2 位 jerseyNumber")
            player_id = player_id.strip()
            if player_id in seen_player_ids:
                raise ValueError("同一场比赛的 playerId 不能重复")
            seen_player_ids.add(player_id)
            if number in numbers:
                raise ValueError(f"{code} 的 jerseyNumber 不能重复")
            numbers.add(number)
            aliases = player.get("aliases", [])
            intervals = player.get("activeIntervals", [])
            if not isinstance(aliases, list) or not all(isinstance(alias, str) and alias.strip() for alias in aliases):
                raise ValueError(f"{player_name} 的 aliases 必须是字符串数组")
            if not isinstance(intervals, list) or not all(
                isinstance(interval, dict)
                and isinstance(interval.get("startSeconds"), (int, float))
                and isinstance(interval.get("endSeconds"), (int, float))
                and interval["endSeconds"] > interval["startSeconds"] >= 0
                for interval in intervals
            ):
                raise ValueError(f"{player_name} 的 activeIntervals 无效")
            normalized_players.append({
                "playerId": player_id,
                "name": player_name.strip(),
                "jerseyNumber": number,
                "aliases": [alias.strip() for alias in aliases],
                "activeIntervals": intervals,
            })
        normalized_teams.append({"teamCode": code, "teamName": name.strip(), "players": normalized_players})
    return {"version": "1.0", "gameId": game_id.strip(), "teams": normalized_teams}


def process_job(job_id: str, video_path: Path, roster_path: Path | None = None) -> None:
    capture = cv2.VideoCapture(str(video_path))
    try:
        if not capture.isOpened():
            raise RuntimeError("无法读取视频，请确认文件是有效的 MP4 或 MOV")
        source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        if source_fps <= 0 or frame_count <= 0 or width <= 0 or height <= 0:
            raise RuntimeError("视频元数据不完整")
        duration = frame_count / source_fps
        stride = max(1, round(source_fps / TARGET_FPS))
        expected = max(1, (frame_count + stride - 1) // stride)
        write_job(job_id, {
            "status": "extracting_frames",
            "progress": 12,
            "videoDurationSeconds": duration,
            "sourceFps": source_fps,
            "processedFps": source_fps / stride,
        })

        model = get_model()
        write_job(job_id, {"status": "analyzing", "progress": 20})
        frames: list[dict[str, Any]] = []
        video_evidence: list[dict[str, Any]] = []
        track_colors: dict[int, list[list[float]]] = {}
        track_number_crops: dict[int, list[np.ndarray]] = {}
        frame_index = 0
        processed = 0
        last_scoreboard_seconds = -SCOREBOARD_INTERVAL_SECONDS

        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % stride != 0:
                frame_index += 1
                continue
            analysis_frame = frame.copy()
            current_seconds = frame_index / source_fps
            if current_seconds - last_scoreboard_seconds >= SCOREBOARD_INTERVAL_SECONDS:
                scoreboard_text = ocr_scoreboard_text(frame)
                if scoreboard_text:
                    video_evidence.append({
                        "type": "scoreboard",
                        "value": scoreboard_text,
                        "atSeconds": round(frame_index / source_fps, 3),
                        "confidence": round(0.55 if re.search(r"\d", scoreboard_text) else 0.35, 3),
                        "source": "local-tesseract-scoreboard",
                    })
                last_scoreboard_seconds = current_seconds
            analysis_frame[: int(height * 0.22), :] = 0
            analysis_frame[int(height * 0.91) :, :] = 0
            result = model.track(
                analysis_frame,
                persist=True,
                tracker=str(TRACKER_CONFIG),
                classes=list(DETECTOR_CLASSES),
                conf=min(PLAYER_MIN_CONFIDENCE, BALL_MIN_CONFIDENCE),
                iou=0.5,
                imgsz=MODEL_SIZE,
                device=DEVICE,
                half=DEVICE != "cpu",
                verbose=False,
            )[0]
            players: list[dict[str, Any]] = []
            ball: dict[str, Any] | None = None
            if result.boxes is not None:
                xyxy = result.boxes.xyxy.cpu().numpy()
                classes = result.boxes.cls.cpu().numpy().astype(int)
                confidence = result.boxes.conf.cpu().numpy()
                ids = result.boxes.id.cpu().numpy().astype(int) if result.boxes.id is not None else np.full(len(xyxy), -1)
                for raw_box, class_id, score, track_id in zip(xyxy, classes, confidence, ids):
                    x1, y1, x2, y2 = [float(value) for value in raw_box]
                    normalized = {
                        "x": max(0.0, min(1.0, x1 / width)),
                        "y": max(0.0, min(1.0, y1 / height)),
                        "width": max(0.0, min(1.0, (x2 - x1) / width)),
                        "height": max(0.0, min(1.0, (y2 - y1) / height)),
                    }
                    if class_id == PLAYER_CLASS_ID and track_id >= 0 and float(score) >= PLAYER_MIN_CONFIDENCE and is_court_person(normalized):
                        player = {
                            "trackId": int(track_id),
                            "label": f"球员 {int(track_id):02d}",
                            "role": "player",
                            "team": "unknown",
                            "confidence": round(float(score), 4),
                            "identityConfidence": 0.0,
                            "identitySource": "unconfirmed",
                            "box": normalized,
                        }
                        players.append(player)
                        features = jersey_features(frame, [x1, y1, x2, y2])
                        if features is not None:
                            track_colors.setdefault(int(track_id), []).append(features)
                        crop = jersey_number_crop(frame, [x1, y1, x2, y2])
                        samples = track_number_crops.setdefault(int(track_id), [])
                        if crop is not None and len(samples) < 8:
                            samples.append(crop)
                    elif class_id == BALL_CLASS_ID and float(score) >= BALL_MIN_CONFIDENCE:
                        candidate = {"confidence": round(float(score), 4), "box": normalized}
                        if ball is None or candidate["confidence"] > ball["confidence"]:
                            ball = candidate
            frames.append({
                "atSeconds": round(frame_index / source_fps, 3),
                "players": players,
                **({"ball": ball} if ball else {}),
            })
            processed += 1
            if processed % 12 == 0:
                write_job(job_id, {"progress": min(82, 20 + round(processed / expected * 62))})
            frame_index += 1

        if not frames:
            raise RuntimeError("视觉模型没有处理到任何视频帧")
        observation_counts: dict[int, int] = {}
        for frame in frames:
            for player in frame["players"]:
                track_id = player["trackId"]
                observation_counts[track_id] = observation_counts.get(track_id, 0) + 1
        minimum_observations = max(5, math.ceil((source_fps / stride) * MIN_TRACK_SECONDS))
        valid_tracks = {track_id for track_id, count in observation_counts.items() if count >= minimum_observations}
        track_remap = merge_track_fragments(frames, valid_tracks, track_colors)
        apply_track_remap(frames, track_remap)
        valid_tracks = set(track_remap.values())
        merged_colors: dict[int, list[list[float]]] = {}
        merged_number_crops: dict[int, list[np.ndarray]] = {}
        for track_id, colors in track_colors.items():
            if track_id in track_remap:
                merged_colors.setdefault(track_remap[track_id], []).extend(colors)
        for track_id, crops in track_number_crops.items():
            if track_id in track_remap:
                merged_number_crops.setdefault(track_remap[track_id], []).extend(crops)
        track_colors = merged_colors
        track_number_crops = merged_number_crops
        removed_ball_candidates = filter_ball_candidates(frames)
        display_ids = {track_id: index + 1 for index, track_id in enumerate(sorted(valid_tracks))}
        referee_tracks = {
            track_id for track_id in valid_tracks
            if AUTO_REFEREE_FILTER and referee_candidate(track_colors.get(track_id, []))
        }
        player_tracks = valid_tracks - referee_tracks
        for frame in frames:
            frame["players"] = [player for player in frame["players"] if player["trackId"] in valid_tracks]
            for player in frame["players"]:
                track_id = player["trackId"]
                if track_id in referee_tracks:
                    player["role"] = "referee-candidate"
                    player["label"] = "裁判候选"
                    player["team"] = "unknown"
                else:
                    player["label"] = f"球员 {display_ids[track_id]:02d}"
        track_colors = {track_id: colors for track_id, colors in track_colors.items() if track_id in valid_tracks}
        team_mapping = assign_teams(frames, track_colors, player_tracks)
        tracks: dict[int, dict[str, Any]] = {}
        for frame in frames:
            for player in frame["players"]:
                track_id = player["trackId"]
                summary = tracks.setdefault(track_id, {
                    "trackId": track_id,
                    "label": player["label"],
                    "role": player["role"],
                    "team": player["team"],
                    "firstSeen": frame["atSeconds"],
                    "lastSeen": frame["atSeconds"],
                    "observations": 0,
                    "identityConfidence": 0.0,
                    "identitySource": "unconfirmed",
                })
                summary["lastSeen"] = frame["atSeconds"]
                summary["observations"] += 1

        roster = parse_roster(roster_path)
        roster_summary = None
        if roster is not None:
            roster_summary = {
                "gameId": roster["gameId"],
                "sourceFile": roster_path.name,
                "teamCodes": [team["teamCode"] for team in roster["teams"]],
                "playerCount": sum(len(team["players"]) for team in roster["teams"]),
                "players": [
                    {
                        "teamCode": team["teamCode"],
                        "playerId": player["playerId"],
                        "name": player["name"],
                        "jerseyNumber": player["jerseyNumber"],
                    }
                    for team in roster["teams"]
                    for player in team["players"]
                ],
            }

        ocr_matches = vote_jersey_numbers({
            track_id: crops for track_id, crops in track_number_crops.items() if track_id in player_tracks
        })
        roster_by_number: dict[str, list[dict[str, Any]]] = {}
        if roster_summary is not None:
            for player in roster_summary["players"]:
                roster_by_number.setdefault(player["jerseyNumber"], []).append(player)
        for track_id, (number, confidence) in ocr_matches.items():
            candidate = tracks.get(track_id)
            if candidate is None:
                continue
            candidate["jerseyNumber"] = number
            candidate["identityConfidence"] = confidence
            matches = roster_by_number.get(number, [])
            if len(matches) == 1:
                player = matches[0]
                candidate.update({
                    "label": player["name"],
                    "playerId": player["playerId"],
                    "playerName": player["name"],
                    "identitySource": "ocr",
                })
        identity_by_track = {track_id: item for track_id, item in tracks.items() if item.get("playerName")}
        for frame in frames:
            for player in frame["players"]:
                identity = identity_by_track.get(player["trackId"])
                if identity is not None:
                    player.update({key: value for key, value in identity.items() if key in {
                        "label", "jerseyNumber", "playerId", "playerName", "identityConfidence", "identitySource"
                    }})

        tracking = {
            "version": "1.0",
            "video": {
                "width": width,
                "height": height,
                "durationSeconds": round(duration, 3),
                "sourceFps": round(source_fps, 3),
                "processedFps": round(source_fps / stride, 3),
            },
            "model": {"name": MODEL_NAME, "device": DEVICE, "imageSize": MODEL_SIZE},
            "quality": {
                "frameCoverage": round(sum(1 for frame in frames if frame["players"]) / max(1, len(frames)), 4),
                "ballFrameCoverage": round(sum(1 for frame in frames if frame.get("ball")) / max(1, len(frames)), 4),
                "trackCount": len(player_tracks),
                "processedFrameCount": len(frames),
                "playerVisibleFrameCount": sum(1 for frame in frames if frame["players"]),
                "ballVisibleFrameCount": sum(1 for frame in frames if frame.get("ball")),
                "identifiedTrackCount": len(identity_by_track),
                "ocrIdentityCount": sum(1 for item in identity_by_track.values() if item.get("identitySource") == "ocr"),
            },
            "videoEvidence": video_evidence[:160],
            "frames": frames,
            "tracks": sorted(tracks.values(), key=lambda item: item["trackId"]),
            **({"roster": roster_summary} if roster_summary else {}),
            "warnings": [
                "球员姓名尚未确认时显示轨迹编号。",
                "球队颜色为无监督候选结果，需要结合比赛名单和球衣号码校验。",
                "当前使用 COCO 通用检测模型，人物和篮球仍需结合人工复核，不能据此证明球员身份或球权。",
                *([f"已合并 {sum(1 for source, target in track_remap.items() if source != target)} 条短暂中断的轨迹片段。"] if any(source != target for source, target in track_remap.items()) else []),
                *([f"已过滤 {removed_ball_candidates} 个缺少时序支持的篮球候选。"] if removed_ball_candidates else []),
                *(["球员轨迹数量明显高于篮球场上人数，可能存在 ID 切换或场边误检；请在质量面板复核。"] if len(player_tracks) > 20 else []),
                *(["篮球有效帧覆盖率低于 20%，不会把最近一次篮球位置当作当前帧。"] if sum(1 for frame in frames if frame.get("ball")) / max(1, len(frames)) < 0.2 else []),
                *(["未检测到本地 Tesseract，号码 OCR 已跳过；可通过人工身份校验确认轨迹。"] if not TESSERACT_PATH else []),
                *([f"号码 OCR 已确认 {len(identity_by_track)} 条唯一名单轨迹。"] if identity_by_track else []),
                *([f"检测到 {len(referee_tracks)} 条裁判候选轨迹，未参与球队和姓名匹配。"] if referee_tracks else []),
            ],
        }
        output_path = job_dir(job_id) / "tracking.json"
        output_path.write_text(json.dumps(tracking, ensure_ascii=False), encoding="utf-8")
        write_job(job_id, {
            "status": "completed",
            "progress": 100,
            "trackingUrl": f"/local-api/jobs/{job_id}/tracking",
            "videoUrl": f"/local-api/jobs/{job_id}/video",
            "detectedTracks": len(player_tracks),
            "refereeCandidates": len(referee_tracks),
            "identifiedTracks": sum(1 for item in tracks.values() if item.get("playerName")),
            "teamClusters": len(set(team_mapping.values())),
            "modelDevice": DEVICE,
        })
    except Exception as error:
        write_job(job_id, {"status": "failed", "progress": 100, "error": str(error)})
    finally:
        capture.release()


@app.get("/local-api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "device": DEVICE,
        "model": MODEL_NAME,
        "trackingFps": TARGET_FPS,
        "detectorClasses": list(DETECTOR_CLASSES),
        "playerClassId": PLAYER_CLASS_ID,
        "ballClassId": BALL_CLASS_ID,
        "playerMinConfidence": PLAYER_MIN_CONFIDENCE,
        "ballMinConfidence": BALL_MIN_CONFIDENCE,
        "dataRoot": str(DATA_ROOT),
    }


@app.post("/local-api/jobs", status_code=202)
async def create_job(
    video: UploadFile = File(...),
    data: UploadFile | None = File(None),
    roster: UploadFile | None = File(None),
) -> dict[str, Any]:
    content_type = video.content_type or ""
    if content_type not in {"video/mp4", "video/quicktime", "application/octet-stream"}:
        raise HTTPException(status_code=415, detail="只支持 MP4 或 MOV 视频")
    job_id = str(uuid.uuid4())
    directory = job_dir(job_id)
    input_directory = directory / "input"
    input_directory.mkdir(parents=True, exist_ok=False)
    video_name = safe_name(video.filename, "input.mp4")
    video_path = input_directory / video_name
    with video_path.open("wb") as target:
        shutil.copyfileobj(video.file, target)
    data_name = None
    data_path = None
    if data is not None:
        data_name = safe_name(data.filename, "data.json")
        data_path = input_directory / data_name
        with data_path.open("wb") as target:
            shutil.copyfileobj(data.file, target)
    roster_name = None
    roster_path = None
    if roster is not None:
        if not (roster.filename or "").lower().endswith(".json"):
            raise HTTPException(status_code=415, detail="比赛名单必须使用 JSON 文件")
        roster_name = safe_name(roster.filename, "roster.json")
        roster_path = input_directory / roster_name
        with roster_path.open("wb") as target:
            shutil.copyfileobj(roster.file, target)
        try:
            parse_roster(roster_path)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
    elif data_path is not None and data_path.suffix.lower() == ".json":
        try:
            parse_roster(data_path)
            roster_path = data_path
            roster_name = data_name
        except ValueError:
            pass
    timestamp = utc_now()
    job = {
        "id": job_id,
        "status": "queued",
        "progress": 5,
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "videoFileName": video_name,
        "dataFileName": data_name,
        "rosterFileName": roster_name,
        "modelDevice": DEVICE,
    }
    write_job(job_id, job)
    executor.submit(process_job, job_id, video_path, roster_path)
    return job


@app.get("/local-api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    return read_job(job_id)


@app.post("/local-api/jobs/{job_id}/identities")
def update_identities(job_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Persist reviewer-confirmed names without ever treating them as OCR output."""
    path = job_dir(job_id) / "tracking.json"
    if not path.is_file():
        raise HTTPException(status_code=409, detail="轨迹结果尚未生成")
    assignments = payload.get("assignments")
    if not isinstance(assignments, list) or not assignments:
        raise HTTPException(status_code=422, detail="assignments 必须是非空数组")
    tracking = json.loads(path.read_text(encoding="utf-8"))
    roster = tracking.get("roster")
    if not isinstance(roster, dict) or not isinstance(roster.get("players"), list):
        raise HTTPException(status_code=409, detail="请先在任务中上传比赛名单，才能人工确认身份")
    players_by_id = {player["playerId"]: player for player in roster["players"] if isinstance(player, dict) and "playerId" in player}
    tracks_by_id = {track["trackId"]: track for track in tracking.get("tracks", []) if isinstance(track, dict)}
    for assignment in assignments:
        if not isinstance(assignment, dict) or not isinstance(assignment.get("trackId"), int):
            raise HTTPException(status_code=422, detail="每条身份确认必须包含整数 trackId")
        track = tracks_by_id.get(assignment["trackId"])
        if track is None or track.get("role") != "player":
            raise HTTPException(status_code=422, detail="只能确认存在的球员轨迹")
        player_id = assignment.get("playerId")
        if player_id is not None and not isinstance(player_id, str):
            raise HTTPException(status_code=422, detail="playerId 必须是字符串或 null")
        if player_id is None:
            track.update({"label": f"轨迹 {track['trackId']}", "identityConfidence": 0.0, "identitySource": "unconfirmed"})
            for key in ("jerseyNumber", "playerId", "playerName"):
                track.pop(key, None)
        else:
            roster_player = players_by_id.get(player_id)
            if roster_player is None:
                raise HTTPException(status_code=422, detail="所选球员不在当前比赛名单中")
            track.update({
                "label": roster_player["name"],
                "jerseyNumber": roster_player["jerseyNumber"],
                "playerId": roster_player["playerId"],
                "playerName": roster_player["name"],
                "identityConfidence": 1.0,
                "identitySource": "manual",
            })
        for frame in tracking.get("frames", []):
            for observed in frame.get("players", []):
                if observed.get("trackId") == track["trackId"]:
                    for key in ("label", "jerseyNumber", "playerId", "playerName", "identityConfidence", "identitySource"):
                        if key in track:
                            observed[key] = track[key]
                        else:
                            observed.pop(key, None)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(tracking, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)
    write_job(job_id, {"identifiedTracks": sum(1 for track in tracks_by_id.values() if track.get("playerName"))})
    return tracking


@app.get("/local-api/jobs/{job_id}/tracking")
def get_tracking(job_id: str) -> FileResponse:
    path = job_dir(job_id) / "tracking.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="轨迹结果尚未生成")
    return FileResponse(path, media_type="application/json", filename="tracking.json")


@app.get("/local-api/jobs/{job_id}/video")
def get_video(job_id: str) -> FileResponse:
    job = read_job(job_id)
    path = job_dir(job_id) / "input" / job["videoFileName"]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="视频不存在")
    return FileResponse(path, media_type="video/mp4")
