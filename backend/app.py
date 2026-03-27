# -*- coding: utf-8 -*-
"""
WebRTC + SRS 实时直播 - Flask 后端代理服务（统一 HTTPS 入口）

核心功能：
1. 对外提供 HTTPS 服务（浏览器唯一入口，统一端口）
2. 代理浏览器的推流/拉流信令请求到 SRS 服务器（HTTP 内部通信）
3. 提供静态文件服务（前端页面）
4. 统一错误处理和日志记录

架构说明（简化后）：
  浏览器 <==HTTPS==> Flask 代理 <--HTTP--> SRS 服务器（内部通信）
  浏览器 <===WebRTC UDP===> SRS 服务器（媒体数据直连，DTLS 加密）

  浏览器只需信任 Flask 的 HTTPS 证书即可，无需单独访问 SRS。
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
load_dotenv()

# 禁用 SSL 警告（SRS 使用自签名证书时需要）
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# SRS 服务器配置（从环境变量读取，提供默认值）
# 注意：Flask 到 SRS 走内部 HTTP，不需要 HTTPS
SRS_API_BASE = os.getenv("SRS_API_BASE", "http://localhost:1985")
SRS_STREAM_URL = os.getenv("SRS_STREAM_URL", "webrtc://localhost:1985/live/livestream")

# SSL 证书路径（Flask 对外提供 HTTPS）
SSL_CERT = os.getenv("SSL_CERT", os.path.join(os.path.dirname(__file__), "..", "ssl", "server.crt"))
SSL_KEY = os.getenv("SSL_KEY", os.path.join(os.path.dirname(__file__), "..", "ssl", "server.key"))

# 录制文件存储目录
RECORDINGS_DIR = os.path.join(os.path.dirname(__file__), "recordings")
os.makedirs(RECORDINGS_DIR, exist_ok=True)

# 日志配置
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
    返回服务状态、SRS 连接状态等信息，用于运维监控
    """
    srs_status = "unknown"
    try:
        # 尝试访问 SRS API 检测连通性
        resp = requests.get(
            f"{SRS_API_BASE}/api/v1/versions",
            timeout=3,
            verify=False
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

    流程：
    1. 前端浏览器创建 WebRTC Offer SDP
    2. 通过此接口将 SDP 转发至 SRS 服务器
    3. SRS 返回 Answer SDP，代理回传给浏览器
    4. 浏览器与 SRS 建立 WebRTC 连接，开始推流

    请求体：
    {
        "sdp": "<Offer SDP 字符串>",
        "streamurl": "<可选：自定义流地址>"
    }
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

    流程：
    1. 前端浏览器创建 WebRTC Offer SDP（recvonly 模式）
    2. 通过此接口将 SDP 转发至 SRS 服务器
    3. SRS 返回 Answer SDP，代理回传给浏览器
    4. 浏览器与 SRS 建立 WebRTC 连接，开始拉流播放

    请求体：
    {
        "sdp": "<Offer SDP 字符串>",
        "streamurl": "<可选：自定义流地址>"
    }
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

    请求体（multipart/form-data）：
        video: 视频文件
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

    返回：
        code: 状态码
        recordings: 录制文件列表
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

    参数：
        filename: 文件名
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

    参数：
        filename: 文件名
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
    """服务首页"""
    return send_from_directory(app.static_folder, "index.html")


@app.route("/<path:filename>")
def serve_static(filename):
    """服务其他前端静态文件"""
    return send_from_directory(app.static_folder, filename)


# ============================================================
# 应用启动入口
# ============================================================

if __name__ == "__main__":
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
