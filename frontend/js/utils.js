/**
 * WebRTC 公共工具函数模块
 *
 * 功能描述：
 *   提供 WebRTC 推流和拉流共用的工具方法，封装复杂的 WebRTC API 操作
 *
 * 主要功能：
 *   - SDP（会话描述协议）编解码处理，优先使用 H.264 编码
 *   - ICE（交互式连接建立）候选收集异步等待机制
 *   - 与后端代理的信令请求封装
 *   - 连接状态检查与格式化工具
 *
 * 使用场景：
 *   - 前端推流页面（publish.js）
 *   - 前端拉流页面（play.js）
 *
 * 技术要点：
 *   - SRS 服务器对 H.264 兼容性最佳，需通过 SDP 重排优先级
 *   - WebRTC 连接建立前必须完成 ICE 候选收集
 *   - 信令通过 Flask 后端代理转发，不直接连接 SRS API
 *
 * @author WebRTC-Live Project
 * @version 1.0.0
 * @last-modified 2026-03-30
 */

// ============================================================
// API 基础配置（通过 Flask 后端代理，无需直连 SRS）
// ============================================================
const API_BASE = window.location.origin;

/**
 * 等待 ICE 候选收集完成
 *
 * WebRTC 建立连接前需要收集 ICE 候选（网络路径信息）。
 * 此函数返回一个 Promise，在所有候选收集完毕后 resolve。
 *
 * @param {RTCPeerConnection} pc - RTCPeerConnection 实例
 * @param {number} timeout - 超时时间（毫秒），默认 5000ms
 * @returns {Promise<string>} 包含完整 ICE 候选的 SDP 字符串
 */
function waitForIceGathering(pc, timeout = 5000) {
    return new Promise((resolve, reject) => {
        // 设置超时定时器，防止 ICE 收集卡死
        const timer = setTimeout(() => {
            // 超时后使用当前已收集的 SDP（可能不完整但通常可用）
            if (pc.localDescription) {
                console.warn("[ICE] 收集超时，使用当前已有候选");
                resolve(pc.localDescription.sdp);
            } else {
                reject(new Error("ICE 候选收集超时且无可用 SDP"));
            }
        }, timeout);

        // 如果 ICE 已经收集完成，直接返回
        if (pc.iceGatheringState === "complete") {
            clearTimeout(timer);
            resolve(pc.localDescription.sdp);
            return;
        }

        // 监听 ICE 候选收集状态变化
        pc.addEventListener("icegatheringstatechange", () => {
            if (pc.iceGatheringState === "complete") {
                clearTimeout(timer);
                resolve(pc.localDescription.sdp);
            }
        });
    });
}


/**
 * 优先使用 H.264 编码
 *
 * SRS 对 H.264 兼容性最佳，通过修改 SDP 中的编码优先级，
 * 确保 WebRTC 连接优先选择 H.264 编码。
 *
 * @param {string} sdp - 原始 SDP 字符串
 * @returns {string} 优化后的 SDP 字符串
 */
function preferH264(sdp) {
    // 分割 SDP 为多行进行处理
    const lines = sdp.split("\r\n");
    const result = [];
    let videoMlineIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 找到视频媒体行 (m=video)
        if (line.startsWith("m=video")) {
            videoMlineIndex = i;

            // 解析当前 payload types
            const parts = line.split(" ");
            const header = parts.slice(0, 3);
            const payloadTypes = parts.slice(3);

            // 找出所有 H.264 的 payload type
            const h264PayloadTypes = [];
            const otherPayloadTypes = [];

            for (const pt of payloadTypes) {
                // 在后续的 rtpmap 行中查找该 payload type 对应的编码
                const rtpmapLine = lines.find(
                    l => l.startsWith(`a=rtpmap:${pt}`) && l.toLowerCase().includes("h264")
                );
                if (rtpmapLine) {
                    h264PayloadTypes.push(pt);
                } else {
                    otherPayloadTypes.push(pt);
                }
            }

            // H.264 排在前面（优先使用）
            const reorderedPts = [...h264PayloadTypes, ...otherPayloadTypes];
            result.push([...header, ...reorderedPts].join(" "));
            continue;
        }

        result.push(line);
    }

    return result.join("\r\n");
}


/**
 * 发送信令请求到 Flask 后端代理
 *
 * @param {string} endpoint - API 路径（如 "/api/publish" 或 "/api/play"）
 * @param {string} sdp - 本地 SDP 字符串
 * @param {string} streamUrl - 可选的自定义流地址
 * @returns {Promise<Object>} SRS 返回的响应数据
 */
async function sendSignaling(endpoint, sdp, streamUrl = null) {
    const payload = { sdp };
    if (streamUrl) {
        payload.streamurl = streamUrl;
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`信令请求失败 (${response.status}): ${errorText}`);
    }

    const result = await response.json();

    // 检查 SRS 业务状态码
    if (result.code !== 0) {
        throw new Error(`SRS 错误 (code=${result.code}): ${result.error || "未知错误"}`);
    }

    return result;
}


/**
 * 创建标准的 RTCPeerConnection 实例
 *
 * 使用适配 SRS 的默认配置：
 * - 不不使用外部 ICE 服务器（SRS 通过 HTTP API 交换候选）
 * - 使用 max-bundle 策略（合并媒体到单条连接）
 * - 必须使用 RTCP 多路复用
 *
 * @param {Object} extraConfig - 额外的 RTCConfiguration 属性
 * @returns {RTCPeerConnection}
 */
function createPeerConnection(extraConfig = {}) {
    const config = {
        iceServers: [],                 // SRS 不需要 STUN/TURN
        bundlePolicy: "max-bundle",     // 合并音视频到一条连接
        rtcpMuxPolicy: "require",       // 要求 RTCP 多路复用
        ...extraConfig
    };

    const pc = new RTCPeerConnection(config);

    // 通用连接状态日志
    pc.addEventListener("connectionstatechange", () => {
        console.log(`[WebRTC] 连接状态: ${pc.connectionState}`);
    });

    pc.addEventListener("iceconnectionstatechange", () => {
        console.log(`[WebRTC] ICE 连接状态: ${pc.iceConnectionState}`);
    });

    return pc;
}


/**
 * 格式化时间为 HH:MM:SS
 *
 * @param {number} seconds - 秒数
 * @returns {string} 格式化时间字符串（例如：01:23:45）
 */
function formatTime(seconds) {
    const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
    const s = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${h}:${m}:${s}`;
}


/**
 * 检查浏览器是否支持 WebRTC
 *
 * 检测项：
 *   - RTCPeerConnection API 是否存在
 *   - navigator.mediaDevices API 是否存在
 *   - getUserMedia 方法是否可用
 *
 * @returns {boolean} 是否支持 WebRTC 功能
 */
function checkWebRTCSupport() {
    return !!(
        window.RTCPeerConnection &&
        navigator.mediaDevices &&
        navigator.mediaDevices.getUserMedia
    );
}


/**
 * 检查浏览器是否支持屏幕捕获
 *
 * 屏幕捕获 API 现代浏览器支持情况：
 *   - Chrome 72+ ✅
 *   - Firefox 66+ ✅
 *   - Safari 13+ ✅
 *   - Edge (Chromium) ✅
 *
 * @returns {boolean} 是否支持屏幕捕获
 */
function checkScreenCaptureSupport() {
    return !!(
        navigator.mediaDevices &&
        navigator.mediaDevices.getDisplayMedia
    );
}
