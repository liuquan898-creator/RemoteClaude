package com.remoteclaude.android.rtc

import org.webrtc.RTCStats
import org.webrtc.RTCStatsReport
import kotlin.math.roundToInt

/** 画面连接的统计信息，用于调试浮层（安卓设计文档"建议加的调试功能"一节） */
data class StreamStats(
    val width: Int,
    val height: Int,
    val fps: Double,
    val kbps: Int,
    val rttMs: Int?,
    /** 是否经 TURN 中继；还没选出候选对时为 null */
    val relayed: Boolean?,
    val localType: String?,
    val remoteType: String?,
    val codec: String?,
)

/** 从 WebRTC 统计报告里取出关心的几项；码率按两次读数的差值计算 */
class StatsReader {
    private var lastBytes = -1L
    private var lastTimeUs = 0.0

    fun reset() {
        lastBytes = -1L
        lastTimeUs = 0.0
    }

    fun read(report: RTCStatsReport): StreamStats? {
        val map = report.statsMap
        val inbound = map.values.firstOrNull {
            it.type == "inbound-rtp" && (it.members["kind"] == "video" || it.members["mediaType"] == "video")
        } ?: return null
        val m = inbound.members

        val bytes = m.num("bytesReceived")?.toLong() ?: 0L
        val kbps = if (lastBytes >= 0 && inbound.timestampUs > lastTimeUs) {
            ((bytes - lastBytes) * 8.0 / ((inbound.timestampUs - lastTimeUs) / 1_000_000.0) / 1000.0).roundToInt()
        } else {
            0
        }
        lastBytes = bytes
        lastTimeUs = inbound.timestampUs

        val codec = (m["codecId"] as? String)?.let { map[it]?.members?.get("mimeType") as? String }?.removePrefix("video/")

        val transport = map.values.firstOrNull { it.type == "transport" }
        val pair: RTCStats? = (transport?.members?.get("selectedCandidatePairId") as? String)?.let { map[it] }
            ?: map.values.firstOrNull {
                it.type == "candidate-pair" && it.members["state"] == "succeeded" && it.members["nominated"] == true
            }
        val rtt = pair?.members?.num("currentRoundTripTime")?.toDouble()?.let { (it * 1000).roundToInt() }
        val localType = (pair?.members?.get("localCandidateId") as? String)?.let { map[it]?.members?.get("candidateType") as? String }
        val remoteType = (pair?.members?.get("remoteCandidateId") as? String)?.let { map[it]?.members?.get("candidateType") as? String }
        val relayed = if (localType == null && remoteType == null) null else localType == "relay" || remoteType == "relay"

        return StreamStats(
            width = m.num("frameWidth")?.toInt() ?: 0,
            height = m.num("frameHeight")?.toInt() ?: 0,
            fps = m.num("framesPerSecond")?.toDouble() ?: 0.0,
            kbps = kbps.coerceAtLeast(0),
            rttMs = rtt,
            relayed = relayed,
            localType = localType,
            remoteType = remoteType,
            codec = codec,
        )
    }

    // 统计里的无符号 64 位整数是 BigInteger，其它数值是 Long、Integer 或 Double，统一按 Number 处理
    private fun Map<String, Any>.num(key: String): Number? = this[key] as? Number
}
