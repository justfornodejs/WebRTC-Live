# -*- coding: utf-8 -*-
"""
WebRTC + SRS 实时直播 - Flask 后端代理服务（统一 HTTPS 入口）
#
# 功能描述：
#   1. 对外提供 HTTPS 服务（浏览器唯一入口，统一端口）
#   2. 代理浏览器的推流/拉流信令请求到 SRS 服务器（HTTP 内部通信）
#   3. 提供静态文件服务（前端页面）
#   4. 统一错误处理和日志记录
#
# 架构说明：
#   浏览器 <==HTTPS==> Flask 代理 <--HTTP--> SRS 服务器（内部通信）
#   浏览器 <===WebRTC UDP===> SRS 服务器（媒体数据直连，DTLS 加密）
#
#   Flask 代理负责：
#     - HTTPS 证书管理（通过 NPM 代理）
#     - CORS 跨域处理
#     - 信令 SDP 代理转发
#     - 录制文件管理 API
#
# 安全特性：
#   - 严格路径遍历防护（录制文件下载/删除）
#   - 请求超时控制
#   - 异常捕获与日志记录
#
# 作者：WebRTC-Live Project
# 版本：1.0.0
# 最后修改日期：2026-03-30
"""

import os
import logging
from datetime import datetime

import requests
import urllib3
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv

# ============================================================
# 初始化配置
# ============================================================

# 加载 .env 配置文件
# 从项目根目录的 .env 文件读取环境变量
# 优先级：环境变量 > .env 文件 > 代码默认值
load_dotenv()

# 禁用 SSL 警告（SRS 使用自签名证书时需要）
# Flask 与 SRS 内部通信使用 HTTP（不验证证书）
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# SRS 服务器配置（从环境变量读取，提供默认值）
# 注意：Flask 到 SRS 走内部 HTTP，不需要 HTTPS
SRS_API_BASE = os.getenv("SRS_API_BASE", "http://localhost:1985")
SRS_STREAM_URL = os.getenv("SRS_STREAM_URL", "webrtc://localhost:1985/live/livestream")

# SSL 证书路径（Flask 对外提供 HTTPS）
# 证书由 NPM (Nginx Proxy Manager) 管理，Flask 仅通过代理对外服务
# 开发环境可使用自签名证书进行测试
SSL_CERT = os.getenv("SSL_CERT", os.path.join(os.path.dirname(__file__), "..", "ssl", "server.crt"))
SSL_KEY = os.getenv("SSL_KEY", os.path.join(os.path.dirname(__file__), "..", "ssl", "server.key"))

# 录制文件存储目录
# 通过 Docker 挂载实现持久化存储
RECORDINGS_DIR = os.path.join(os.path.dirname(__file__), "recordings")
os.makedirs(RECORDINGS_DIR, exist_ok=True)

# 日志配置
# 输出格式：[时间戳] [日志级别] 消息内容
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger(__name__)

# ============================================================
# Flask 应用初始化
# ============================================================

# 创建 Flask 应用，指定前端静态文件目录
app = Flask(
    __name__,
    static_folder=os.path.join(os.path.dirname(__file__), "..", "frontend"),
    static_url_path=""
)

# 安全密钥配置
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "dev-secret-key")

# 启用跨域资源共享（CORS），允许前端跨域请求
CORS(app, resources={r"/api/*": {"origins": "*"}})


# ============================================================
# 健康检查接口
# ============================================================

@app.route("/api/health", methods=["GET"])
def health_check():
    """
    健康检查端点
    用于运维监控、负载均衡器健康检查、自动化部署验证

    返回信息：
        status: Flask 服务运行状态
        srs_server: SRS 服务器地址配置
        srs_status: SRS 连接状态（connected/disconnected/error）
        timestamp: 当前服务器时间（ISO 8601 格式）

    状态说明：
        connected: SRS API 正常响应
        disconnected: SRS 无法连接（网络/服务故障）
        error (code): SRS 响应异常（HTTP 错误码）
    """
    srs_status = "unknown"
    try:
        # 尝试访问 SRS API 检测连通性
        # GET /api/v1/versions 返回 SRS 版本信息，轻量级健康检测
        resp = requests.get(
            f"{SRS_API_BASE}/api/v1/versions",
            timeout=3,          # 3 秒超时，快速失败
            verify=False         # 跳过证书验证（SRS 内部通信）
        )
        if resp.status_code == 200:
            srs_status = "connected"
        else:
            srs_status = f"error ({resp.status_code})"
    except requests.exceptions.RequestException as e:
        srs_status = f"disconnected ({str(e)[:50]})"

    return jsonify({
        "status": "running",
        "srs_server": SRS_API_BASE,
        "srs_status": srs_status,
        "timestamp": datetime.now().isoformat()
    })


# ============================================================
# WebRTC 推流信令代理
# ============================================================

@app.route("/api/publish", methods=["POST"])
def publish():
    """
    WebRTC 推流信令代理

    WebRTC 推流建立流程：
        1. 前端浏览器创建 RTCPeerConnection 实例
        2. 浏览器生成 Offer SDP（包含 ICE 候选、编码能力等）
        3. 浏览器将 Offer SDP 发送到此 API
        4. 此代理将 Offer 转发到 SRS 服务器（内部 HTTP）
        5. SRS 生成 Answer SDP（包含 ICE 候选、协商结果）
        6. SRS 返回 Answer SDP，代理回传给浏览器
        7. 浏览器设置远端描述，开始 WebRTC 连接
        8. 媒体数据通过 WebRTC UDP (8000) 直连传输

    请求体（JSON）：
        sdp: Offer SDP 字符串（必填）
        streamurl: 自定义流地址（可选，默认使用环境变量配置）

    返回（JSON）：
        code: 状态码（0 成功，非 0 失败）
        sdp: Answer SDP 字符串（成功时）
        error: 错误信息（失败时）

    错误处理：
        400: 缺少必要的 SDP 参数
        502: SRS 服务器返回错误
        503: 无法连接 SRS 服务器
        504: SRS 服务器响应超时
        500: 服务器内部错误
    """
    try:
        data = request.get_json()
        if not data or "sdp" not in data:
            return jsonify({"code": 400, "error": "缺少必要的 SDP 参数"}), 400

        # 支持自定义流地址，默认使用配置的地址
        stream_url = data.get("streamurl", SRS_STREAM_URL)

        # 构建 SRS 推流信令请求
        payload = {
            "api": f"{SRS_API_BASE}/rtc/v1/publish/",
            "streamurl": stream_url,
            "sdp": data["sdp"]
        }

        logger.info(f"[推流] 转发信令到 SRS: {stream_url}")

        # 转发请求到 SRS（跳过自签名证书验证）
        resp = requests.post(
            f"{SRS_API_BASE}/rtc/v1/publish/",
            json=payload,
            timeout=10,
            verify=False
        )

        result = resp.json()

        # 检查 SRS 返回状态
        if result.get("code", -1) != 0:
            logger.error(f"[推流] SRS 返回错误: {result}")
            return jsonify(result), 502

        logger.info("[推流] 信令协商成功")
        return jsonify(result)

    except requests.exceptions.Timeout:
        logger.error("[推流] SRS 请求超时")
        return jsonify({"code": 504, "error": "SRS 服务器响应超时"}), 504
    except requests.exceptions.ConnectionError:
        logger.error("[推流] 无法连接 SRS 服务器")
        return jsonify({"code": 503, "error": "无法连接 SRS 服务器，请检查服务器状态"}), 503
    except Exception as e:
        logger.exception(f"[推流] 未知错误: {e}")
        return jsonify({"code": 500, "error": f"服务器内部错误: {str(e)}"}), 500


# ============================================================
# WebRTC 拉流信令代理
# ============================================================

@app.route("/api/play", methods=["POST"])
def play():
    """
    WebRTC 拉流信令代理

    WebRTC 拉流建立流程：
        1. 前端浏览器创建 RTCPeerConnection 实例
        2. 添加接收轨道（video/audio，方向为 recvonly）
        3. 浏览器生成 Offer SDP（仅包含接收能力）
        4. 浏览器将 Offer SDP 发送到此 API
        5. 此代理将 Offer 转发到 SRS 服务器（内部 HTTP）
        6. SRS 查找对应的推流，生成 Answer SDP
        7. SRS 返回 Answer SDP，代理回传给浏览器
        8. 浏览器设置远端描述，开始 WebRTC 连接
        9. 媒体数据通过 WebRTC UDP (8000) 直连传输

    请求体（JSON）：
        sdp: Offer SDP 字符串（必填）
        streamurl: 自定义流地址（可选，默认使用环境变量配置）

    返回（JSON）：
        code: 状态码（0 成功，非 0 失败）
        sdp: Answer SDP 字符串（成功时）
        error: 错误信息（失败时）

    错误处理：
        400: 缺少必要的 SDP 参数
        502: SRS 服务器返回错误或流不存在
        503: 无法连接 SRS 服务器
        504: SRS 服务器响应超时
        500: 服务器内部错误
    """
    try:
        data = request.get_json()
        if not data or "sdp" not in data:
            return jsonify({"code": 400, "error": "缺少必要的 SDP 参数"}), 400

        # 支持自定义流地址
        stream_url = data.get("streamurl", SRS_STREAM_URL)

        # 构建 SRS 拉流信令请求
        payload = {
            "api": f"{SRS_API_BASE}/rtc/v1/play/",
            "streamurl": stream_url,
            "sdp": data["sdp"]
        }

        logger.info(f"[拉流] 转发信令到 SRS: {stream_url}")

        # 转发请求到 SRS
        resp = requests.post(
            f"{SRS_API_BASE}/rtc/v1/play/",
            json=payload,
            timeout=10,
            verify=False
        )

        result = resp.json()

        if result.get("code", -1) != 0:
            logger.error(f"[拉流] SRS 返回错误: {result}")
            return jsonify(result), 502

        logger.info("[拉流] 信令协商成功")
        return jsonify(result)

    except requests.exceptions.Timeout:
        logger.error("[拉流] SRS 请求超时")
        return jsonify({"code": 504, "error": "SRS 服务器响应超时"}), 504
    except requests.exceptions.ConnectionError:
        logger.error("[拉流] 无法连接 SRS 服务器")
        return jsonify({"code": 503, "error": "无法连接 SRS 服务器，请检查服务器状态"}), 503
    except Exception as e:
        logger.exception(f"[拉流] 未知错误: {e}")
        return jsonify({"code": 500, "error": f"服务器内部错误: {str(e)}"}), 500


# ============================================================
# SRS 流信息查询接口
# ============================================================

@app.route("/api/streams", methods=["GET"])
def get_streams():
    """
    查询 SRS 当前活跃的流列表
    用于前端展示可用的直播流

    请求方式：GET
    无需参数

    返回（SRS API 响应）：
        code: 状态码（0 成功）
        streams: 活跃流列表
            - publish: 推流信息（publish_url、stream_id 等）
            - clients: 连接的客户端列表
            - info: 流统计信息（bitrate、fps 等）

    使用场景：
        - 前端页面刷新时获取当前推流状态
        - 监控面板显示活跃流信息
        - 多房间/多流场景下的流管理
    """
    try:
        resp = requests.get(
            f"{SRS_API_BASE}/api/v1/streams/",
            timeout=5,
            verify=False
        )
        return jsonify(resp.json())
    except requests.exceptions.RequestException as e:
        logger.error(f"[流查询] 获取失败: {e}")
        return jsonify({"code": 503, "error": "无法获取流信息"}), 503


# ============================================================
# 录制文件管理 API
# ============================================================

@app.route("/api/recordings/upload", methods=["POST"])
def upload_recording():
    """
    上传前端录制的视频文件
    前端使用 MediaRecorder API 录制推流/拉流画面，然后通过此接口保存到服务器

    请求方式：POST
    请求类型：multipart/form-data

    请求参数：
        video: 视频文件（必填，支持 WebM/MP4 格式）

    返回（JSON）：
        code: 状态码（0 成功）
        message: 操作结果描述
        filename: 服务器存储的文件名（含时间戳）
        size: 文件大小（字节）

    安全特性：
        - 文件名包含时间戳前缀，防止覆盖
        - 仅保存到配置的录制目录
        - 记录文件大小用于监控

    返回示例：
        {
            "code": 0,
            "message": "上传成功",
            "filename": "20260330_123045_video.webm",
            "size": 15728640
        }
    """
    try:
        if "video" not in request.files:
            return jsonify({"code": 400, "error": "没有上传文件"}), 400

        file = request.files["video"]
        if file.filename == "":
            return jsonify({"code": 400, "error": "文件名为空"}), 400

        # 生成唯一文件名（添加时间戳）
        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{timestamp}_{file.filename}"

        # 保存文件
        filepath = os.path.join(RECORDINGS_DIR, filename)
        file.save(filepath)

        file_size = os.path.getsize(filepath)
        logger.info(f"[录制上传] 文件已保存: {filename} ({file_size} bytes)")

        return jsonify({
            "code": 0,
            "message": "上传成功",
            "filename": filename,
            "size": file_size
        })

    except Exception as e:
        logger.exception(f"[录制上传] 上传失败: {e}")
        return jsonify({"code": 500, "error": f"上传失败: {str(e)}"}), 500


@app.route("/api/recordings/list", methods=["GET"])
def list_recordings():
    """
    获取录制文件列表
    用于前端展示已保存的录制文件，支持下载/删除操作

    请求方式：GET
    无需参数

    返回（JSON）：
        code: 状态码（0 成功）
        recordings: 录制文件列表
            - filename: 文件名
            - size: 文件大小（字节）
            - created: 创建时间戳（秒）
            - modified: 修改时间戳（秒）
        count: 文件总数

    文件排序：按修改时间倒序（最新在前）
    """
    try:
        recordings = []

        # 遍历录制目录
        if os.path.exists(RECORDINGS_DIR):
            for filename in os.listdir(RECORDINGS_DIR):
                filepath = os.path.join(RECORDINGS_DIR, filename)
                if os.path.isfile(filepath):
                    # 获取文件信息
                    stat = os.stat(filepath)
                    recordings.append({
                        "filename": filename,
                        "size": stat.st_size,
                        "created": stat.st_ctime,
                        "modified": stat.st_mtime
                    })

        # 按修改时间倒序排列
        recordings.sort(key=lambda x: x["modified"], reverse=True)

        return jsonify({
            "code": 0,
            "recordings": recordings,
            "count": len(recordings)
        })

    except Exception as e:
        logger.exception(f"[录制列表] 获取失败: {e}")
        return jsonify({"code": 500, "error": f"获取列表失败: {str(e)}"}), 500


@app.route("/api/recordings/download/<filename>", methods=["GET"])
def download_recording(filename):
    """
    下载录制文件
    生成 HTTP 响应，触发浏览器的文件下载行为

    请求方式：GET
    路径参数：
        filename: 文件名（URL 编码）

    返回：文件二进制流（Content-Disposition: attachment）

    安全特性：
        - 路径遍历防护：拒绝包含 / 或 \ 的文件名
        - 路径拼接限制：仅允许在配置目录下访问文件

    错误处理：
        400: 无效的文件名（包含路径分隔符）
        404: 文件不存在
        400: 目标不是文件（是目录或其他）
    """
    try:
        # 安全检查：防止路径遍历攻击
        if "/" in filename or "\\" in filename:
            return jsonify({"code": 400, "error": "无效的文件名"}), 400

        filepath = os.path.join(RECORDINGS_DIR, filename)

        if not os.path.exists(filepath):
            return jsonify({"code": 404, "error": "文件不存在"}), 404

        if not os.path.isfile(filepath):
            return jsonify({"code": 400, "error": "不是文件"}), 400

        logger.info(f"[录制下载] 文件下载: {filename}")

        return send_from_directory(RECORDINGS_DIR, filename, as_attachment=True)

    except Exception as e:
        logger.exception(f"[录制下载] 下载失败: {e}")
        return jsonify({"code": 500, "error": f"下载失败: {str(e)}"}), 500


@app.route("/api/recordings/delete/<filename>", methods=["DELETE"])
def delete_recording(filename):
    """
    删除录制文件
    从服务器存储中永久删除指定的录制文件

    请求方式：DELETE
    路径参数：
        filename: 文件名（URL 编码）

    返回（JSON）：
        code: 状态码（0 成功）
        message: 操作结果描述
        filename: 已删除的文件名

    安全特性：
        - 路径遍历防护：拒绝包含 / 或 \ 的文件名
        - 路径拼接限制：仅允许在配置目录下删除文件
        - 完整性检查：删除前验证文件存在且为常规文件

    错误处理：
        400: 无效的文件名（包含路径分隔符）
        404: 文件不存在
        400: 目标不是文件（是目录或其他）

    返回示例：
        {
            "code": 0,
            "message": "删除成功",
            "filename": "20260330_123045_video.webm"
        }
    """
    try:
        # 安全检查
        if "/" in filename or "\\" in filename:
            return jsonify({"code": 400, "error": "无效的文件名"}), 400

        filepath = os.path.join(RECORDINGS_DIR, filename)

        if not os.path.exists(filepath):
            return jsonify({"code": 404, "error": "文件不存在"}), 404

        if not os.path.isfile(filepath):
            return jsonify({"code": 400, "error": "不是文件"}), 400

        # 删除文件
        os.remove(filepath)

        logger.info(f"[录制删除] 文件已删除: {filename}")

        return jsonify({
            "code": 0,
            "message": "删除成功",
            "filename": filename
        })

    except Exception as e:
        logger.exception(f"[录制删除] 删除失败: {e}")
        return jsonify({"code": 500, "error": f"删除失败: {str(e)}"}), 500


# ============================================================
# 静态文件服务（前端页面）
# ============================================================

@app.route("/")
def serve_index():
    """
    服务首页
    路由根路径到 index.html
    用于单页应用（SPA）的入口路由
    """
    return send_from_directory(app.static_folder, "index.html")


@app.route("/<path:filename>")
def serve_static(filename):
    """
    服务其他前端静态文件
    处理所有静态资源请求：
        - HTML 文件
        - CSS 样式表
        - JavaScript 脚本
        - 图片、字体等资源

    参数：
        filename: 相对于静态根目录的文件路径

    Flask 静态文件特性：
        - 自动处理 Content-Type（MIME 类型）
        - 支持 ETag 缓存头
        - 支持范围请求（大文件分片传输）
    """
    return send_from_directory(app.static_folder, filename)


# ============================================================
# 应用启动入口
# ============================================================

if __name__ == "__main__":
    """
    Flask 开发服务器启动入口
    注意：生产环境使用 Gunicorn 启动（见 Dockerfile CMD）
    此入口仅用于本地开发测试

    启动流程：
        1. 检查 SSL 证书文件是否存在
        2. 配置 HTTPS 或 HTTP 模式
        3. 输出启动信息（访问地址、SRS 配置等）
        4. 启动 Flask 服务器

    环境变量：
        FLASK_HOST: 监听地址（默认 0.0.0.0）
        FLASK_PORT: 监听端口（默认 5000）
        FLASK_DEBUG: 调试模式（默认 true，生产应设为 false）
    """
    host = os.getenv("FLASK_HOST", "0.0.0.0")
    port = int(os.getenv("FLASK_PORT", 5000))
    debug = os.getenv("FLASK_DEBUG", "true").lower() == "true"

    # 检查 SSL 证书是否存在
    ssl_context = None
    if os.path.exists(SSL_CERT) and os.path.exists(SSL_KEY):
        ssl_context = (SSL_CERT, SSL_KEY)
        protocol = "https"
    else:
        protocol = "http"
        logger.warning("未找到 SSL 证书，将以 HTTP 模式启动")
        logger.warning(f"  期望证书位置: {SSL_CERT}")
        logger.warning(f"  期望私钥位置: {SSL_KEY}")
        logger.warning("  HTTP 模式下 WebRTC 仅在 localhost 可用")

    logger.info("=" * 60)
    logger.info("WebRTC + SRS 实时直播代理服务启动")
    logger.info(f"  访问地址: {protocol}://{host}:{port}")
    logger.info(f"  SRS 服务器: {SRS_API_BASE}（内部 HTTP）")
    logger.info(f"  流地址: {SRS_STREAM_URL}")
    logger.info(f"  HTTPS: {'✅ 已启用' if ssl_context else '❌ 未启用（仅 localhost 可用）'}")
    logger.info(f"  调试模式: {debug}")
    logger.info("=" * 60)

    app.run(host=host, port=port, debug=debug, ssl_context=ssl_context)
