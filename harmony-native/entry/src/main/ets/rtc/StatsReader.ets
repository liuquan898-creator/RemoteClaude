import webrtc from '@ohos/webrtc';
import { StreamStats } from '../model/AppState';

/** 两次读数之间要记的东西：码率、帧率按差值算 */
export class StatsCursor {
  lastBytes: number = -1;
  lastFrames: number = -1;
  lastTs: number = 0;
}

export interface StatsRead {
  /** 解码出的总帧数，大于 0 说明画面出来了 */
  framesDecoded: number;
  view: StreamStats;
}

/**
 * 从 WebRTC 统计报告里取出关心的几项（分辨率、帧率、码率、往返延迟、直连还是中继），
 * 对照安卓端 rtc/StatsReader.kt。统计项是动态对象，按字段名取。
 */
export function readStats(report: webrtc.RTCStatsReport, cur: StatsCursor): StatsRead | null {
  const all = new Map<string, Record<string, Object>>();
  report.stats.forEach((v: webrtc.RTCStats, k: string) => {
    all.set(k, v as Object as Record<string, Object>);
  });
  let inbound: Record<string, Object> | null = null;
  let transport: Record<string, Object> | null = null;
  let nominated: Record<string, Object> | null = null;
  for (const s of Array.from(all.values())) {
    const type = s['type'] as string;
    if (type === 'inbound-rtp' && (s['kind'] === 'video' || s['mediaType'] === 'video')) {
      inbound = s;
    } else if (type === 'transport') {
      transport = s;
    } else if (type === 'candidate-pair' && s['state'] === 'succeeded' && s['nominated'] === true) {
      nominated = s;
    }
  }
  if (inbound === null) {
    return null;
  }
  const m: Record<string, Object> = inbound;
  const bytes = num(m, 'bytesReceived');
  const frames = num(m, 'framesDecoded');
  const ts = num(m, 'timestamp');
  const dt = (ts - cur.lastTs) / 1000;
  const kbps = cur.lastBytes >= 0 && dt > 0 ? Math.max(0, Math.round((bytes - cur.lastBytes) * 8 / 1000 / dt)) : 0;
  let fps = num(m, 'framesPerSecond');
  if (fps <= 0 && cur.lastFrames >= 0 && dt > 0) {
    fps = (frames - cur.lastFrames) / dt;
  }
  cur.lastBytes = bytes;
  cur.lastFrames = frames;
  cur.lastTs = ts;

  const codecId = m['codecId'] as string;
  const codecStats = codecId !== undefined ? all.get(codecId) : undefined;
  let codec = codecStats !== undefined ? (codecStats['mimeType'] as string ?? '') : '';
  if (codec.startsWith('video/')) {
    codec = codec.substring(6);
  }
  let pair: Record<string, Object> | null = null;
  const t: Record<string, Object> | null = transport;
  if (t !== null) {
    const id = t['selectedCandidatePairId'] as string;
    pair = id !== undefined ? (all.get(id) ?? null) : null;
  }
  if (pair === null) {
    pair = nominated;
  }
  let rttMs = -1;
  let route = '';
  if (pair !== null) {
    const p: Record<string, Object> = pair;
    const rtt = p['currentRoundTripTime'];
    rttMs = typeof rtt === 'number' ? Math.round((rtt as number) * 1000) : -1;
    const local = all.get(p['localCandidateId'] as string);
    const remote = all.get(p['remoteCandidateId'] as string);
    const lt = local !== undefined ? (local['candidateType'] as string ?? '') : '';
    const rt = remote !== undefined ? (remote['candidateType'] as string ?? '') : '';
    route = lt === 'relay' || rt === 'relay' ? `中继（${lt}/${rt}）` : `直连（${lt}/${rt}）`;
  }
  return {
    framesDecoded: frames,
    view: {
      width: num(m, 'frameWidth'),
      height: num(m, 'frameHeight'),
      fps: Math.round(fps * 10) / 10,
      kbps: kbps,
      rttMs: rttMs,
      codec: codec,
      decoder: (m['decoderImplementation'] as string) ?? '',
      route: route,
      dropped: num(m, 'framesDropped')
    }
  };
}

function num(o: Record<string, Object>, key: string): number {
  const v = o[key];
  return typeof v === 'number' ? v as number : 0;
}
